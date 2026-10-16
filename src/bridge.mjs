#!/usr/bin/env node
/**
 * DSH ⇄ VS Code AHP 桥（codex 模式）
 *
 * 形态：本进程被 VS Code 的本地 agent host spawn，
 *   对外（stdout/stdin）扮演 codex app-server；
 *   对内 spawn `dsh --profile acp`，扮演 ACP 客户端。
 *
 * 启动方式（由 provider 注入代码调用）：
 *   node bridge.mjs --dsh-bin <path/to/dsh/lib/bin.js> --node <node.exe> --cwd <workspace>
 */

import { createStdioRpcEndpoint, JsonRpcErrorCode } from "./rpc.mjs";
import { DshAcpClient, probeT } from "./dsh-acp-client.mjs";
import { BridgeError, ErrorKind, classifyError, toRpcError, asIdempotent } from "./errors.mjs";
import { CODEX_HOST_REQUEST, CODEX_CLIENT_REQUEST, CODEX_NOTIFICATION, DSH_AGENT } from "./method-names.mjs";
import {
  threadStartToSessionNew, sessionNewToThreadStart, turnStartToPrompt,
  translateSessionUpdate, translatePromptDone, translateTurnStarted, translateTokenUsage,
  translatePermissionRequest, translateApprovalToAcpOutcome,
  buildSkillsListResult, threadReadResult, translateModelSelectionToDsh,
  mergeModelCapabilities, toCodexModels, toCodexThread, buildHooksListResult,
  resolveDshModelValue, translateConfigOptionsToModels,
  transcriptEventsToTurns,
} from "./translate.mjs";
import { buildSkillsList, discoverMcpServers, readSessionTimestampIndex } from "./discovery.mjs";
import { readTranscript, extractConversationEvents, extractSessionTitle, findTranscriptBySessionId } from "./transcript.mjs";
import { discoverPresets } from "./presets.mjs";
import {
  syncByokToDshPatch, byokToDshProviders, checkCredentials, credentialHint, listCredentialRefs,
  applyPermissionModeToProfile, resolvePermissionModeFromPatch,
} from "./profile-patch.mjs";
import {
  resolveDshModeFromSignals, dshModeToPermissionMode, permissionModeToDshMode,
  codexModeToDshMode, DSH_SANDBOX_MODES, DSH_DEFAULT_MODE,
  resolveTurnPermissionAxes,
} from "./permission-mode.mjs";
import { WorktreeManager, WORKTREE_META_KEY, WORKTREE_METHOD } from "./worktree.mjs";

// ---------------------------------------------------------------- CLI 参数
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      // ★ 2026-10-16（V2 启动器对接）：同时支持 `--key=value` 与 `--key value` 两种形态。
      //   为什么必须支持 `=`：V2 的 C 启动器（launcher.c）用 `--dsh-bin=<abs path>` 形式传参
      //   —— 这样**整条命令只有一个词**，Windows 命令行解析器无法把带空格的路径拆成两半
      //   （`--dsh-bin C:\a b\bin.js` 会被拆词）。旧版 parseArgs 只认空格分隔
      //   ⇒ `k` 变成 `"dsh-bin=C:\...\bin.js"` ⇒ `args["dsh-bin"]` 恒 undefined
      //   ⇒ 桥日志 `dsh=undefined`、回落自动发现（或彻底失败）。
      const raw = a.slice(2);
      const eq = raw.indexOf("=");
      if (eq > 0) {
        const k = raw.slice(0, eq);
        out[k] = raw.slice(eq + 1);
        continue;
      }
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[raw] = v;
    }
  }
  return out;
}

const args = parseArgs(process.argv);
const HOST_PROVIDER_ID = args["provider-id"] ?? "dsh";
const HOST_PREFIX = `agent-host-${HOST_PROVIDER_ID}`;
const LOG = (level, msg) => process.stderr.write(`[bridge] ${level}: ${msg}\n`);

/**
 * ★★★ 流程日志（FLOW LOG，2026-10-16 新增，**排障用**）
 *
 * 【为什么需要】排"发消息不返回 / 卡在正在分析"这类问题时，`agenthost.log` 里
 *   只有 VS Code 侧的碎片信息，**看不出"请求走到桥的哪一步、卡在哪一段"**。
 *   本组函数把桥内**每个阶段的入口/出口/耗时/异常**打成单行、可 grep 的日志。
 *
 * 【设计要点】
 *   - 统一前缀 `[flow]` ⇒ `grep "\[flow\]"` 一条命令看全链路；
 *   - 每行带 **阶段名 + 方向(→/←/!)+ 关键标识(thread/turn) + 耗时ms**；
 *   - 用 `FLOW_ID` 贯穿一次 turn：**同一 turnId 的所有行按时间排列 = 时序图**；
 *   - 开关：默认开；`--flow-log false` 可关（避免海量日志拖慢）。
 *
 * 【典型用法】
 *   grep "\[flow\]" agenthost.log | tail -40        # 看最近一次请求的完整路径
 *   grep "\[flow\]" agenthost.log | grep "turn-abc" # 盯某一个 turn
 *   grep "\[flow\] !" agenthost.log                 # 只看异常/卡点
 */
const FLOW_LOG = String(args["flow-log"] ?? "true") !== "false";
const _flowStart = new Map();   // key → hrtime，用于算耗时

/** 记录"进入某阶段"。key 建议 `<method>:<threadId>:<turnId>`。 */
function flowIn(stage, key, extra = "") {
  if (!FLOW_LOG) return;
  _flowStart.set(key, process.hrtime.bigint());
  LOG("info", `[flow] → ${stage}${extra ? " " + extra : ""}`);
}
/** 记录"离开某阶段"（带耗时）。 */
function flowOut(stage, key, extra = "") {
  if (!FLOW_LOG) return;
  const t0 = _flowStart.get(key);
  const ms = t0 ? Number(process.hrtime.bigint() - t0) / 1e6 : -1;
  _flowStart.delete(key);
  LOG("info", `[flow] ← ${stage}${extra ? " " + extra : ""}${ms >= 0 ? ` (${ms.toFixed(1)}ms)` : ""}`);
}
/** 记录"异常/卡点"（**排障时优先 grep 这一行**）。 */
function flowErr(stage, err, extra = "") {
  LOG("error", `[flow] ! ${stage}${extra ? " " + extra : ""} :: ${err?.message ?? err}`);
}
/** 旁路标记（不发请求，只标注"即将发出某个通知/应答"）。 */
function flowMark(stage, extra = "") {
  if (!FLOW_LOG) return;
  LOG("info", `[flow] · ${stage}${extra ? " " + extra : ""}`);
}

/**
 * ★ 通知发出前的一致性自检（**防"桥发了但契约不合法"的静默失败**）。
 *   血案：`turn/completed` 缺 `turn` 包装 ⇒ VS Code `params.turn.id` 抛
 *   `Cannot read properties of undefined (reading 'id')` ⇒ UI 卡"正在分析"。
 *   本函数对**带 turn 的通知**断言 `params.turn.id` 存在，早失败、早定位。
 */
/**
 * ★★★ 把异常转成「用户能看懂、并且知道下一步做什么」的文本（2026-10-16 新增）。
 *
 * 【为什么单独抽成一个函数】此前两处各写一份（turn 失败、DSH 死亡），
 *   其中一处对 AUTH 特判跳过 hint ⇒ 两处行为不一致，且 AUTH 恰恰是最需要指引的类：
 *   用户看到"您的 IP 不在令牌允许访问的列表中"的第一反应是"软件坏了"，
 *   而非"我该去刷白名单"。**统一真源，避免再次分叉。**
 *
 * 【输出形状】
 *   ```
 *   <原始技术原因（含 request id，便于对账）>
 *
 *   👉 <可执行的下一步>
 *   ```
 *   该文本最终会成为官方 `TurnError.message` ⇒ 经 `mapTurnCompleted` 变成
 *   `ChatError` ⇒ 由 VS Code **原样展示在对话里**。所以它必须是"人能读的"。
 */
function userFacingErrorText(e, stage) {
  const be = classifyError(e, stage ? { stage } : {});
  const raw = String(e?.message ?? e ?? "未知错误");
  const hint = be.hint && !raw.includes(be.hint) ? be.hint : "";
  return hint ? `${raw}\n\n👉 ${hint}` : raw;
}

/**
 * ★ 出站通知**契约自检**（2026-10-16 新增，同日补强为可抛模式）。
 *
 * 【为什么必须有】本轮系列故障的共同形态是：
 *   桥发出**形状不合规但看着合理**的通知 ⇒ 上游 handler 抛错 **被 .catch 吞掉**
 *   ⇒ UI 静默卡死（"正在分析"永不停），用户得不到任何提示。
 *   **在桥侧发出前自检，等于把"上游静默崩"提前成"桥侧明确日志/异常"。**
 *
 * 【两种模式】
 *   - 宽松（默认）：只打 error 日志，仍继续发送。用于"不想因为自检反而中断业务"的路径。
 *   - 严格（strict=true）：发现不合规**抛 Error**。用于"宁可不发，也不发畸形包"的关键路径
 *     （如 DSH 死亡时的错误收尾 —— 此时再发畸形态只会叠加一个新的静默崩）。
 *
 * @returns {string[]} 违规项清单（空数组 = 合规）
 * @throws 当 strict=true 且存在违规时
 */
function assertTurnShape(method, params, requiredTop = ["threadId", "turn"], strict = false) {
  const violations = [];
  const missing = requiredTop.filter((k) => params?.[k] === undefined);
  if (missing.length) {
    violations.push(`${method} 缺 top-level 必填 ${JSON.stringify(missing)} ` +
      `(实际 keys=${JSON.stringify(Object.keys(params ?? {}))})`);
  }
  if (params?.turn !== undefined) {
    const tm = ["id", "items", "status"].filter((k) => params.turn[k] === undefined);
    if (tm.length) {
      violations.push(`${method}.turn 缺必填 ${JSON.stringify(tm)} ` +
        `(实际 keys=${JSON.stringify(Object.keys(params.turn))})`);
    }
    // `TurnStatus` 白名单（官方枚举）—— 传错值上游同样按未知分支处理/丢弃
    const STATUS_OK = ["inProgress", "completed", "interrupted", "failed"];
    if (params.turn.status !== undefined && !STATUS_OK.includes(params.turn.status)) {
      violations.push(`${method}.turn.status 非法值 ${JSON.stringify(params.turn.status)} ` +
        `(合法: ${STATUS_OK.join("|")})`);
    }
    // `turn.error` 若存在，须是官方 `TurnError`（required = ["message"]）
    if (params.turn.error !== undefined) {
      if (typeof params.turn.error?.message !== "string" || !params.turn.error.message) {
        violations.push(`${method}.turn.error 缺必填 message（官方 TurnError.required=["message"]）`);
      }
    }
  } else if (requiredTop.includes("turn")) {
    violations.push(`${method} 缺 turn 对象（官方 required 含 turn）`);
  }

  if (violations.length) {
    for (const v of violations) LOG("error", `[flow] ! CONTRACT ${v}`);
    if (strict) throw new Error(`出站契约不合规（拒绝发送）: ${violations.join("; ")}`);
  }
  return violations;
}

/**
 * ★ 路线 C 开关：是否把 VS Code BYOK 的 provider **写入** DSH profile patch。
 *
 * 默认 **false（只读对账）** —— 原因：
 *   ① 它会修改用户 DSH 配置文件，属"用户可见的持久副作用"，必须显式开启；
 *   ② 需要 ACP profile 已启用 HMR 才热生效（否则要重启 DSH）；
 *   ③ 新 provider 需要补凭据（VS Code 的 key 在加密 SecretStorage，桥拿不到）。
 * 开启方式：桥 CLI 加 `--sync-byok-write true`（注入层可透传）。
 * 无论开关如何，都会做一次**只读对账**并在 stderr 输出缺口（便于诊断"为什么 VS Code 里模型对不上"）。
 */
const SYNC_BYOK_WRITE = String(args["sync-byok-write"] ?? "false") === "true";
const BYOK_FILE = args["byok-file"]
  ?? `${process.env.APPDATA ?? ""}/Code/User/chatLanguageModels.json`;
/** BYOK 写盘后等待 HMR 热加载的时长（实测 9s 内完成；取 1200ms 为保守下限 +
 *  实际 model/list 还会再 await 一次 bootstrap 会话，足够稳定）。*/
const HMR_SETTLE_MS = Number(args["hmr-settle-ms"] ?? 1200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ★ detached worktree 支持开关（默认 **开**）。
 *
 * 关闭方式：桥 CLI 加 `--worktree false`（或 `--worktree-support false`）。
 * 关闭后 initialize **不宣告** `_meta["vscode.detachedWorktrees"]`，
 * 5 个方法也回 -32601 —— 语义等价于"该 host 不支持 worktree"，
 * VS Code 在 isolation=worktree 时会明确抛 NLS[6194]（而不是静默行为异常）。
 */
const WORKTREE_SUPPORT = String(args["worktree"] ?? args["worktree-support"] ?? "true") !== "false";

/**
 * ★ 路线 B：DSH 安装根目录（用于发现 shipped presets）。
 *
 * 缺省从 `--dsh-bin` 反推：`<install>/lib/bin.js` → `<install>`。
 * 也支持显式 `--dsh-install-dir`。
 */
const DSH_INSTALL_DEFAULT = (() => {
  if (args["dsh-install-dir"]) return args["dsh-install-dir"];
  const bin = args["dsh-bin"];
  if (typeof bin === "string" && bin.length) {
    // .../node_modules/@deepseek-ai/dsh/lib/bin.js → .../node_modules/@deepseek-ai/dsh
    const m = bin.replace(/\\/g, "/").match(/^(.*)\/lib\/bin\.js$/);
    if (m) return m[1];
  }
  return null;
})();

const rpc = createStdioRpcEndpoint(process.stdin, process.stdout, { label: "vscode→bridge", log: LOG, flowLog: FLOW_LOG });

const dsh = new DshAcpClient({
  nodePath: args.node ?? process.execPath,
  dshBinPath: args["dsh-bin"],
  profile: args.profile ?? "acp",
  cwd: args.cwd ?? process.cwd(),
  /**
   * ★ 2026-10-15：把 `--dsh-home` 透传为子进程的 `DSH_HOME`。
   *
   * 血案：旧版桥只用 `args["dsh-home"]` 解析 patch/profile **路径**，却**不给 DSH 子进程**
   *   设 DSH_HOME ⇒ DSH 仍读默认 `~/.dsh` ⇒ 两者**指向不同 home**，profile 级扩展
   *   （如 `node_modules/@deepseek-ai/dsh-acp` shadow 补丁）在 DSH 侧**根本不加载**。
   *   修：显式注入 DSH_HOME，使「桥解析的 home」与「DSH 实际用的 home」严格一致。
   *   未传 --dsh-home 时不注入 ⇒ 保持 DSH 自身默认行为（向后兼容）。
   */
  env: args["dsh-home"] ? { ...process.env, DSH_HOME: args["dsh-home"] } : undefined,
  log: LOG,
});

/**
 * ★★★ DSH 子进程死亡 / spawn 失败 → **主动推通知给 VS Code**（2026-10-16 新增）。
 *
 * 【缺陷背景】旧实现里子进程死亡只写一行日志（`dsh acp exited (code=1)`），
 *   桥**不告诉任何人**。后果：
 *     - 用户界面上正在跑的那一轮永远停在"正在分析"（没有任何错误气泡）；
 *     - 后续请求要等满超时才失败，且报错是 `transport closed`（与真因无关）。
 *
 * 【做法】① `abortAll` 立刻 reject 在途请求（不干等超时）；
 *        ② 借 `thread/statusChanged` 通知把「后端已停止 + 原因」送到 UI；
 *        ③ 同时向所有活跃 thread 各发一次，保证当前看的那个会话一定收到。
 *
 * ★ 契约注意：通知必须满足 VS Code 侧的 required（threadId + status）。
 *   若某版本不认这个通知，最坏情况是被忽略 —— 不会像缺字段那样抛异常（已用 assert 兜住）。
 */
dsh.onExit((err, info) => {
  const msg = err?.message ?? "DSH 后端已停止";
  LOG("error", `[flow] ! DSH-EXIT ${msg} ${JSON.stringify(info ?? {})}`);
  try {
    onDshDeath(msg, Array.from(state.byThread.keys()));
  } catch (e) {
    LOG("error", `[flow] ! DSH-EXIT 上报失败（不致命）：${e?.message ?? e}`);
  }
});

/** 桥内状态（codex 模式：按需缓存，不做长驻同步） */
const state = {
  initialized: false,
  // ★ T2：每个 thread 记录 { sessionId, lastConfigOptions, currentTurnId }
  //   currentTurnId 是「轮次单一真源」——turn/start 时生成，此后该 thread 的所有
  //   item 通知都携带它，直到 turn/completed 后清空。
  byThread: new Map(), // threadId → { sessionId, lastConfigOptions, currentTurnId }
  mcpServers: null,    // 惰性缓存：DSH profile 里声明的 MCP server 条目
  /**
   * ★ 模型清单的「底线来源」——它与 byThread 解耦，用于修复冷启动空列表缺陷。
   *
   * 血案（2026-10-11）：`model/list` 原实现只遍历 `state.byThread`（见下方 handleModelList），
   *   ⇒ VS Code 冷启动时若尚未 thread/start，则必然返回 `{models:[]}`
   *   ⇒ VS Code 侧 `Found 0 models` → 回退 Auto → 选中 DSH 不认识的模型
   *   ⇒ 后续 `thread/start` 通道失配 → 等满 120s → `(sendFailed) bridge timeout: thread/start`。
   *
   * 修复：新增「bootstrap 会话」——桥初始化后**独立于任何 VS Code thread** 先建一个
   *   探测 session，把它的 configOptions 缓存在此处作为**默认模型源**。
   *   `model/list` 优先用 byThread 的（含用户切换后的最新态），为空时回落此处。
   */
  bootstrapModels: null,    // translateConfigOptionsToModels 的产物（模型数组）
  bootstrapGroups: null,    // 分组信息（保真）
  bootstrapModel: null,     // 当前默认模型 id
  bootstrapReasoning: null, // reasoning 选项
  bootstrapSessionId: null, // 探测会话 id（用于诊断/复用）
  bootstrapPromise: null,   // 建探测会话的幂等 promise（防并发重复建）
  bootstrapError: null,     // 上次探测失败原因（供 model/list 诊断）
  modelSyncError: null,     // ★ 最近一次「会话模型落地」失败原因（可读，用于向用户反馈）

  /**
   * ★★★ V2 补丁 M7（2026-10-16）：DSH「启动 + 握手」的**串行化幂等 promise**。
   *   血案：三处并发 `dsh.start()` ⇒ 三个 DSH 同时重写 profiles/<p>/cordis.yml ⇒ EPERM。
   *   详见 `ensureDshReady()` 注释。所有需要「DSH 已就绪」的调用方都应 `await ensureDshReady()`，
   *   而**不要**各自 `if (!state.initialized) { await dsh.start(); ... }`。
   */
  startPromise: null,

  /**
   * ★ 2026-10-15：per-model 能力元数据表（DSH 扩展方法 `_deepseek/models` 的产物）。
   *
   *   价值：ACP 标准 model 选项**不带** contextWindow/vision/思考等级，
   *   这张表是这些属性的唯一真值来源。由 `ensureModelCapabilities()` 拉取，
   *   在 `model/list` 组装时经 `mergeModelCapabilities` 合并进模型条目。
   *   旧版 DSH 无此扩展方法 ⇒ 值为 null ⇒ 合并跳过（功能不退化）。
   */
  modelCapabilities: null,     // Array<{provider,id,contextWindow,...}> 或 null
  capabilitiesPromise: null,   // 拉取的幂等 promise
  capabilitiesError: null,     // 上次拉取失败原因（诊断用）

  /**
   * ★ 路线 B（2026-10-11）：DSH agent preset 清单（桥自行发现）。
   *
   *   DSH 的 preset **不通过 ACP 暴露**（dsh-acp 零 preset 引用），故桥直读：
   *     · shipped：@deepseek-ai/dsh-web-app 的 presets/<id>.patch.yml
   *     · bundle：profile 的 bundles 清单里声明 preset 行的 bundle
   *   发现结果缓存在此，供 `agent/list` 返回；并由注入层映射为 VS Code picker 项。
   */
  presets: null,            // discoverPresets() 的 presets 数组
  presetsCounts: null,      // 诊断计数
  presetsPromise: null,     // 幂等 promise
  presetsError: null,
  /** ★ 会话 → 选中的 preset id（由 thread/start 的 agent 参数带来） */
  presetByThread: new Map(),// dshSessionId → presetId

  /**
   * ★★★ 三档权限（2026-10-15）：桥当前生效的 DSH SandboxMode。
   *
   *   DSH 三档 = read-only / workspace-write / danger-full-access（dsh-sandbox-policy 权威）。
   *   ★ DSH **没有 ACP 写通道**（acp 只注册 9 个 onRequest，`set_config_option` 对 preset
   *     抛 AcpPresetLockedError）⇒ 唯一落点是 acp profile patch（HMR 热加载）。
   *   见 src/permission-mode.mjs 顶部完整论证。
   *
   *   `null` = 尚未同步过（保持 DSH 现档，不改文件）。
   */
  permissionMode: null,     // "read-only" | "workspace-write" | "danger-full-access" | null
  /** 最近一次写入 patch 的结果（诊断用） */
  permissionSyncResult: null,
  /**
   * ★ 2026-10-16：三轴诊断记录。
   *   DSH **没有** reviewer（审核方式）/ interaction mode（交互方式）的对应概念
   *   （DSH 只有 sandbox × approval 两轴），故桥不虚构映射，只**如实记录**最近一次
   *   收到的值，供日志/诊断核对"UI 选的到底有没有传下来"。
   */
  lastApprovalsReviewer: null,   // user | auto_review | guardian_subagent
  lastInteractionMode: null,     // plan | default
};

/** ★ detached worktree 管理器（元数据落 ~/.dsh/ahp-worktrees.json） */
const worktrees = new WorktreeManager({ dshHome: args["dsh-home"], log: LOG });

/** 取 DSH 侧声明的 MCP server（转成 ACP session/new 认的形态），惰性 + 缓存 */
async function dshMcpServers() {
  if (state.mcpServers) return state.mcpServers;
  try {
    const { servers } = await discoverMcpServers(args.profile ?? "acp", { dshHome: args["dsh-home"] });
    state.mcpServers = servers.map((s) => s.transport === "streamable-http"
      ? { name: s.name, type: "http", url: s.url, headers: s.headers }
      : { name: s.name, type: "stdio", command: s.command, args: s.args ?? [], env: s.env ?? [] });
  } catch (e) {
    LOG("warn", `resolving DSH mcp servers failed: ${e?.message ?? e}`);
    state.mcpServers = [];
  }
  return state.mcpServers;
}

// ---------------------------------------------------------------- DSH → 桥 的 client 侧处理

// 1) session/request_permission → 转成 codex 审批请求
dsh.setClientRequestHandler(DSH_AGENT.sessionRequestPermission, async (params) => {
  const t = translatePermissionRequest(params);
  try {
    const reply = await rpc.request(t.method, t.params);
    return translateApprovalToAcpOutcome(reply, t.params);
  } catch (e) {
    LOG("warn", `approval round-trip failed: ${e?.message ?? e}`);
    return { outcome: { outcome: "cancelled" } };
  }
});

// 2) fs/* —— 桥直接落地（VS Code 的 fs 能力有限，这里由桥兜底）
dsh.setClientRequestHandler(DSH_AGENT.fsReadTextFile, async (params) => {
  const fs = await import("node:fs/promises");
  const content = await fs.readFile(params.path, "utf8");
  return { content };
});
dsh.setClientRequestHandler(DSH_AGENT.fsWriteTextFile, async (params) => {
  const fs = await import("node:fs/promises");
  await fs.writeFile(params.path, params.content ?? "", "utf8");
  return {};
});

// 3) session/update → 展开成 codex 通知（★ T2：带当前轮次 turnId）
dsh.onSessionUpdate((params) => {
  const rec = state.byThread.get(params?.sessionId);
  /**
   * ★★★ 血案修复（2026-10-16，「发送后无任何消息返回」）：
   *   `translateSessionUpdate` 需要知道「本轮的某个 agentMessage item 是否已发过
   *   `item/started`」——否则 renderer 因缺 `itemToPartId` 映射而**静默丢弃 delta**
   *   （官方 `mapAgentMessageDelta` 原文：*"Got a delta before we saw the
   *   corresponding item/started. Drop it"*）。
   *   `seenAgentItems` 挂在 `rec` 上，**每个 turn 开始（turn/start）时重置**，
   *   避免跨轮 messageId 复用导致漏发 started。
   */
  const ctx = { turnId: rec?.currentTurnId, seenAgentItems: rec?.seenAgentItems, seenReasoningItems: rec?.seenReasoningItems };
  const _translated = translateSessionUpdate(params, ctx);
  /**
   * ★★★ 探针 P5（2026-10-16，钉死「DSH 到底回了什么」）：
   *   把每条 ACP session/update 的 **kind** 与其翻译产物**逐条**落盘。
   *   判据：
   *     · 若 kind=agent_message_chunk 且产物含 item/started（text 非空）
   *       ⇒ 修复生效，模型文本已进入 VS Code 的渲染通道；
   *     · 若 kind 恒为其它（如 available_commands_update / config_option_update）
   *       ⇒ DSH 根本没产出助手文本，问题在上游（模型/网关），不在桥。
   */
  LOG("info", `[probe-turn] T=${probeT()} P5 update kind=${params?.update?.sessionUpdate} ` +
    `turnId=${rec?.currentTurnId ?? "none"} → ` +
    `[${_translated.map((n) => n.method).join(", ") || "∅"}]` +
    (params?.update?.sessionUpdate === "agent_message_chunk"
      ? ` textLen=${(params.update.content?.text ?? "").length} msgId=${params.update.messageId ?? "none"}` : ""));
  for (const n of _translated) {
    rpc.notify(n.method, n.params);
  }
  // ★ T4：token 用量（若 DSH 在 update 里带了 usage）→ thread/tokenUsage/updated
  //   ★ 2026-10-17 加固：usage_update 这条 kind 已在 translateSessionUpdate 内翻译
  //     （见其 case ACP_UPDATE_KIND.usageUpdate）。这里只处理**另一条路**——
  //     DSH 把 usage 挂在 update 外层（`params.usage`）的形态。
  //   ★ 顺带把上下文窗口（`update.size` / `params.size`）透传，让上游能画占用条。
  const usage = params?.usage ?? params?.update?.usage;
  if (usage && rec) {
    const ctxWindow = params?.update?.size ?? params?.size ?? null;
    const n = translateTokenUsage(params.sessionId, rec.currentTurnId, usage, { modelContextWindow: ctxWindow });
    if (n) rpc.notify(n.method, n.params);
  }
});

// ---------------------------------------------------------------- VS Code → 桥 的请求处理

/**
 * ★ 路线 C：把 VS Code BYOK 的 provider 对账/同步到 DSH profile patch。
 *
 * 背景：VS Code 有 `rpc.provider.sync` 想让 host 接住 BYOK，但 ACP stdio 上没有该 RPC；
 *   桥的替代方案 = 写 DSH profile patch + 靠已启用的 HMR 热加载（已端到端实测）。
 *
 * 幂等：并发调用共享同一 promise；内容不变时不写盘（不触发无谓 HMR 重载）。
 * 只读模式（默认）：只计算 + 输出缺口，不动文件。
 */
let byokSyncPromise = null;
function ensureByokSync() {
  if (byokSyncPromise) return byokSyncPromise;
  byokSyncPromise = (async () => {
    const fsp = await import("node:fs/promises");
    let byok;
    try {
      byok = JSON.parse(await fsp.readFile(BYOK_FILE, "utf8"));
    } catch (e) {
      LOG("info", `byok sync: 跳过（读不到 BYOK 配置 ${BYOK_FILE}: ${e?.message ?? e}）`);
      return { skipped: true };
    }
    const provs = byokToDshProviders(byok);
    if (!provs.length) { LOG("info", "byok sync: BYOK 无可用 provider（缺 models 或 url）"); return { skipped: true }; }

    const { missing } = await checkCredentials(provs, { dshHome: args["dsh-home"] });
    LOG("info", `byok sync: ${provs.length} provider [${provs.map((p) => p.key).join(", ")}]` +
      ` | 缺凭据: ${missing.length ? missing.join(", ") : "(无)"}`);

    if (!SYNC_BYOK_WRITE) {
      LOG("info", "byok sync: 只读模式（如需写入 DSH profile patch，请加 --sync-byok-write true）");
      return { provs: provs.length, missing, written: false, readonly: true };
    }

    const res = await syncByokToDshPatch({ byok, profile: args.profile ?? "acp", dshHome: args["dsh-home"] });
    LOG("info", `byok sync: 写 patch -> changed=${res.changed} written=${res.written} added=[${res.added.join(", ")}]` +
      (res.hmrEnabled ? "" : " ⚠️ 该 profile 未启用 HMR，需重启 DSH 才生效"));
    if (missing.length) LOG("warn", `byok sync: 以下 provider 仍需补凭据（否则调用报 MISSING_CREDENTIAL）：\n${credentialHint(provs.filter((p) => missing.includes(p.apiKeyEnv)))}`);
    return { ...res, missing };
  })().catch((e) => {
    byokSyncPromise = null;   // 允许重试
    LOG("warn", `byok sync failed: ${e?.message ?? e}`);
    return { error: e?.message ?? String(e) };
  });
  return byokSyncPromise;
}

/**
 * ★★★ V2 补丁 M7（2026-10-16）：**DSH 启动/握手串行化闸门**（消除并发 spawn 竞态）。
 *
 * 血案（真机前离线复测，症状 `EPERM: open 'C:\Users\liuyue\.dsh\profiles\acp\cordis.yml'`）：
 *   DSH 的 `prepareProfile()` **每次启动都无条件重写** `profiles/<name>/cordis.yml`
 *   （`profile-boot-*.js`：`writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), ...)`）。
 *   而桥有**三处**各自独立地做「if (!initialized) { await dsh.start(); ... }」：
 *     · `initialize` handler（L309）
 *     · `ensureBootstrapModels`（L423）
 *     · `ensureModelCapabilities`（L471）
 *   三者都在 initialize 之后立刻并发启动（VS Code 的 model/list 紧随 initialize 而来）
 *   ⇒ 都读到 `state.initialized === false` ⇒ **三个 DSH 子进程同时 spawn**
 *   ⇒ 同时 `writeFileSync` 同一个 `cordis.yml` ⇒ 后者 `EPERM`（Windows 独占写）
 *   ⇒ 该 DSH 秒退（`dsh acp exited code=1`）⇒ 其通道上所有请求 `transport closed`
 *   ⇒ initialize 回 -32603 ⇒ 握手全挂、model/list 恒 0 项。
 *
 *   为什么此前没暴露：V1 垫片不 spawn DSH；早期测试多为「单次调用 + 大量 sleep」，
 *   并发窗口被 sleep 错开了。真机（VS Code 连发 initialize→model/list→thread/list）
 *   百分百命中。
 *
 * 修法：把「启动 + 握手 + 建探测会话」收敛为**单一幂等 promise**（`state.startPromise`），
 *   所有调用方 `await ensureDshReady()`；失败时清空 promise 允许重试。
 *   与文件既有的 `bootstrapPromise` / `capabilitiesPromise` / `presetsPromise` 同款风格。
 */
async function ensureDshReady() {
  if (state.initialized && dsh.child && !dsh.closed) return;
  if (state.startPromise) return state.startPromise;

  state.startPromise = (async () => {
    // 通道已死（或从未起）⇒ 先优雅关停旧实例，避免残留进程继续占锁
    if (dsh.child && dsh.closed) {
      await dsh.dispose().catch(() => {});
    }
    // ★★★ M7b（2026-10-16）：DSH 启动期 `EPERM ... cordis.yml` 的重试。
    //
    // 现象：DSH 的 `prepareProfile()` 每次启动都无条件 `writeFileSync` 重写
    //   `profiles/<name>/cordis.yml`。当该文件**瞬时**被另一进程（例如桌面/Web 版
    //   DSH 实例、或上一轮未退净的 DSH）占用时，Windows 返回 EPERM，DSH 秒退。
    //   实测：经 C 启动器链路（exe→node→bridge→dsh）时更易命中（句柄继承差异），
    //   直接 node→bridge→dsh 几乎不命中。
    // 这不是桥能"修掉"的上游行为，但桥可以**不因此崩掉**：
    //   退避重试若干次，每次先 dispose 旧进程；瞬时占用通常几十~几百 ms 即释放。
    const maxAttempts = Number(args["dsh-start-retries"] ?? 5);
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await dsh.start();
        await dsh.initialize(
          { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
          { name: "vscode-ahp-dsh-bridge", version: "0.1.0" },
        );
        state.initialized = true;
        if (attempt > 1) LOG("info", `dsh start: 第 ${attempt} 次尝试成功（前 ${attempt - 1} 次失败）`);
        return;
      } catch (e) {
        lastErr = e;
        const transient = /EPERM|EBUSY|transport closed|exited \(code=1/.test(String(e?.message ?? e));
        LOG("warn", `dsh start 尝试 ${attempt}/${maxAttempts} 失败${transient ? "（瞬态，将退避重试）" : ""}：${e?.message ?? e}`);
        await dsh.dispose().catch(() => {});
        if (!transient || attempt === maxAttempts) break;
        await new Promise((r) => setTimeout(r, 250 * attempt));
      }
    }
    throw lastErr ?? new Error("dsh start failed");
  })().catch((e) => {
    state.startPromise = null;        // 允许下次重试
    state.initialized = false;
    throw e;
  });

  return state.startPromise;
}

rpc.onRequest(CODEX_HOST_REQUEST.initialize, async (params) => {
  if (!state.initialized) {
    await ensureDshReady();
    // ★★★ 三档权限（2026-10-15）：读回 acp profile patch 里**当前生效**的 DSH 档，
    //   作为 `state.permissionMode` 的初值 —— 这样首次 setMode 若与现档相同就不写盘（幂等），
    //   且 `permissions/getMode` 能如实回报。纯文件读，无副作用。
    try {
      const { readFile } = await import("node:fs/promises");
      const { resolveProfilePatchPath } = await import("./profile-patch.mjs");
      const p = resolveProfilePatchPath(args.profile ?? "acp", { dshHome: args["dsh-home"] });
      const txt = await readFile(p, "utf8").catch(() => null);
      if (txt !== null) {
        state.permissionMode = resolvePermissionModeFromPatch(txt, process.env);
        LOG("info", `permission: 初始化读回 DSH 档 = ${state.permissionMode ?? "(未显式设置，走 base 默认 workspace-write)"}`);
      }
    } catch (e) {
      LOG("warn", `permission: 读回初始档位失败（不致命）：${e?.message ?? e}`);
    }
  }
  // ★ 预热：立刻在后台建 bootstrap 探测会话，使 VS Code 随后的 model/list 立刻有全量模型。
  //   不 await（不拖慢 initialize 回执）；model/list 侧也会 await 同一个幂等 promise 兜底。
  ensureBootstrapModels().catch(() => { /* 已在内部记录 bootstrapError */ });
  // ★ 路线 C：后台对账 VS Code BYOK ↔ DSH provider（默认只读；写盘需 --sync-byok-write true）。
  //   顺序无强依赖：写入后 HMR 会推 config_option_update，model/list 再次拉取即可见。
  ensureByokSync().catch(() => { /* 内部已记录 */ });
  // ★ 路线 B：预热 preset 发现（纯文件读取，无副作用），使随后的 agent/list 立刻有料。
  ensurePresets().catch(() => { /* 内部已记录 presetsError */ });
  // ★ detached worktree：启动时清理「未被认领的残留」（对齐内置 _cleanupUnclaimedDetachedWorktrees）。
  //   不 await：清理可能涉及 git 操作，不能拖慢 initialize 回执。
  if (WORKTREE_SUPPORT) {
    worktrees.startupCleanup().catch((e) => LOG("warn", `worktree startup cleanup failed: ${e?.message ?? e}`));
  }
  return {
    // ★★★ V2 补丁 M1（2026-10-16）：官方 InitializeResponse 的 4 个**必填**字段。
    //   血案：VS Code `codexAgent.ts` L2599 无条件 `URI.file(initialized.codexHome)`，
    //   缺 `codexHome` ⇒ `URI.file(undefined)` 抛异常 ⇒ 握手成功但连接立即崩。
    //   实测（v2-offline-test.mjs）此四字段全缺。修法：全部补齐（各 1 行取值）。
    //   - userAgent：任意标识串（VS Code 仅透传给日志/诊断）。
    //   - codexHome：**绝对路径**。桥不用文件系统发现（靠 thread/list RPC），
    //     但 CodexChatDiscovery 会监视 `<codexHome>/sessions`，故必须存在且可写。
    //     取 DSH home 下的子目录（顺其自然的归属），并确保目录存在。
    //   - platformFamily：`unix` | `windows`（按 process.platform）。
    //   - platformOs：`macos` | `linux` | `windows`（按 process.platform）。
    userAgent: `dsh-ahp-bridge/0.1.0 (${process.platform}; node ${process.versions.node})`,
    codexHome: await resolveBridgeCodexHome(),
    platformFamily: process.platform === "win32" ? "windows" : "unix",
    platformOs: process.platform === "darwin" ? "macos" : (process.platform === "win32" ? "windows" : "linux"),
    serverInfo: { name: "dsh-ahp-bridge", version: "0.1.0" },
    capabilities: { models: true, skills: true, mcp: true, approvals: true, worktrees: WORKTREE_SUPPORT },
    // ★★ 关键：VS Code 的 gXn() 只读 `initializeResult._meta["vscode.detachedWorktrees"] === true`。
    //   不宣告 ⇒ isolation=worktree 的会话直接抛 NLS[6194]（"does not support preparing a worktree"）。
    //   宣告后 VS Code 还会额外要求 create/claim/delete 三个方法存在（缺一即抛），故下面必须全实现。
    ...(WORKTREE_SUPPORT ? { _meta: { [WORKTREE_META_KEY]: true } } : {}),
  };
});

/**
 * ★ V2 补丁 M1（2026-10-16）：解析/创建 `initialize.codexHome` 指向的目录。
 *
 * 规则：
 *   1. 显式 `--codex-home <path>` 优先；
 *   2. 否则用 `<dsh-home 或默认 DSH home>/bridge-codex-home`；
 *   3. 目录不存在则创建（mkdir -p 语义）；创建失败降级到 os.tmpdir() 下的同名目录。
 * 返回**绝对路径**字符串（官方契约 AbsolutePathBuf）。
 * 注意：若目录创建彻底失败，仍返回路径（不抛）—— 让 VS Code 侧决定，避免 initialize 直接失败。
 *
 * ★ 血案（本补丁自身，2026-10-16）：首版误用 `require("node:fs")` —— 桥是 **ESM**，`require` 未定义
 *   ⇒ `initialize` handler 直接抛 `require is not defined`（-32603）⇒ 握手全挂。
 *   修：改用动态 `await import("node:fs")`（与桥内既有风格一致，见 L223/L228）。
 */
async function resolveBridgeCodexHome() {
  const [{ mkdirSync }, os, path] = await Promise.all([
    import("node:fs"),
    import("node:os"),
    import("node:path"),
  ]);
  const explicit = args["codex-home"] ?? process.env.DSH_BRIDGE_CODEX_HOME;
  let base;
  if (explicit) {
    base = path.resolve(String(explicit));
  } else {
    const dshHome = args["dsh-home"] ?? process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
    base = path.join(String(dshHome), "bridge-codex-home");
  }
  try {
    mkdirSync(base, { recursive: true });
    return base;
  } catch (e) {
    LOG("warn", `codexHome 创建失败（降级到 tmp）：${e?.message ?? e}`);
    const fallback = path.join(os.tmpdir(), "dsh-bridge-codex-home");
    try { mkdirSync(fallback, { recursive: true }); } catch { /* 返回路径本身 */ }
    return fallback;
  }
}

// —— 模型：DSH 无独立 model/list，由桥缓存的 configOptions 合成
/**
 * ★ 建「bootstrap 探测会话」—— 只为一个目的：拿到 DSH 的 configOptions（=全量模型清单），
 *   使得 `model/list` **不依赖 VS Code 是否已经 thread/start**。
 *
 * 这是冷启动空列表缺陷的正解（见 state.bootstrapModels 注释里的血案）。
 * 幂等：并发调用共享同一个 promise；失败后可重试（清空 promise）。
 */
async function ensureBootstrapModels() {
  if (state.bootstrapModels && state.bootstrapModels.length) return state.bootstrapModels;
  if (state.bootstrapPromise) return state.bootstrapPromise;

  state.bootstrapPromise = (async () => {
    const cwd = args.cwd ?? process.cwd();
    // 1) 握手（★ M7：走串行化闸门，与 initialize handler 共用同一个 start promise）
    await ensureDshReady();
    // 2) 建探测会话（DSH 侧一个真实 session；含 mcpServers 以贴近真实会话形态）
    const mcpServers = await dshMcpServers();
    const res = await dsh.newSession({ cwd, mcpServers });
    const t = sessionNewToThreadStart({ sessionId: res.sessionId, configOptions: res.configOptions }, HOST_PREFIX);
    state.bootstrapModels = t.models ?? [];
    state.bootstrapGroups = t.groups ?? [];
    state.bootstrapModel = t.currentModel ?? null;
    state.bootstrapReasoning = t.reasoningOptions ?? null;
    state.bootstrapSessionId = res.sessionId;
    state.bootstrapError = null;
    LOG("info", `bootstrap models ready: ${state.bootstrapModels.length} [${state.bootstrapModels.map((m) => m.id).join(", ")}] session=${res.sessionId}`);
    return state.bootstrapModels;
  })().catch((e) => {
    state.bootstrapError = e?.message ?? String(e);
    state.bootstrapPromise = null;   // 允许下次重试
    LOG("warn", `bootstrap models failed: ${state.bootstrapError}`);
    return [];
  });

  return state.bootstrapPromise;
}

/**
 * ★ 2026-10-15：拉取 per-model 能力元数据（DSH 扩展方法 `_deepseek/models`），幂等。
 *
 * 为什么需要：ACP 标准的 model 选项**只有 value/name/description**，
 *   「多模态 / 思考等级 / 上下文大小」在标准面上不存在；而 AHP 协议的
 *   `SessionModelInfo` 有这些字段的位置（VS Code 的 `Vfe` 会逐字段读）。
 *   DSH 内部有真值（`llm.resolveModelInfo`），此前从不越过进程边界。
 *   本函数把桥与那个扩展方法对接，结果缓存供 `model/list` 合并。
 *
 * 降级：旧版 DSH 无此方法 ⇒ `modelsInfo()` 返回 null ⇒ 本函数记 warn 并返回 null，
 *   合并跳过，模型列表功能完全不受影响（属性为空，与改动前一致）。
 */
async function ensureModelCapabilities() {
  if (state.modelCapabilities) return state.modelCapabilities;
  if (state.capabilitiesPromise) return state.capabilitiesPromise;

  state.capabilitiesPromise = (async () => {
    // 扩展方法与 provider 目录有关，但握手是前置（★ M7：走串行化闸门）。
    await ensureDshReady();
    const res = await dsh.modelsInfo();
    if (res && Array.isArray(res.models)) {
      state.modelCapabilities = res.models;
      state.capabilitiesError = null;
      const withCtx = res.models.filter((m) => typeof m.contextWindow === "number").length;
      const withVision = res.models.filter((m) => typeof m.supportsVision === "boolean").length;
      const withEffort = res.models.filter((m) => Array.isArray(m.reasoningEfforts)).length;
      LOG("info", `model capabilities ready: ${res.models.length} entr(ies) ` +
        `ctx=${withCtx} vision=${withVision} efforts=${withEffort}`);
      return state.modelCapabilities;
    }
    // 旧版 DSH / 方法未注册 ⇒ 降级
    state.capabilitiesError = "extension method unavailable";
    LOG("warn", "model capabilities unavailable — 模型能力属性将为空（需 DSH 侧含 _deepseek/models 扩展）");
    return null;
  })().catch((e) => {
    state.capabilitiesError = e?.message ?? String(e);
    state.capabilitiesPromise = null;   // 允许下次重试
    LOG("warn", `model capabilities fetch failed: ${state.capabilitiesError}`);
    return null;
  });

  return state.capabilitiesPromise;
}

/**
 * ★ 路线 B：确保 preset 清单已发现（幂等）。
 *
 * 发现来源见 presets.mjs。**不 spawn DSH**（纯文件读取），故无副作用、可随时调用。
 */
async function ensurePresets() {
  if (state.presets) return state.presets;
  if (state.presetsPromise) return state.presetsPromise;
  state.presetsPromise = (async () => {
    const res = await discoverPresets({
      dshHome: args["dsh-home"],
      dshInstallDir: args["dsh-install-dir"] ?? DSH_INSTALL_DEFAULT,
      profileName: args.profile ?? "acp",
      includeLegacy: true,
    });
    state.presets = res.presets;
    state.presetsCounts = res.counts;
    state.presetsError = null;
    LOG("info", `presets discovered: ${res.presets.length} [${res.presets.map((p) => p.id).join(", ")}]` +
      ` counts=${JSON.stringify(res.counts)}`);
    return state.presets;
  })().catch((e) => {
    state.presetsError = e?.message ?? String(e);
    state.presetsPromise = null;   // 允许重试
    LOG("warn", `presets discovery failed: ${state.presetsError}`);
    return [];
  });
  return state.presetsPromise;
}

/**
 * ★ 修复：**先建 bootstrap 再列** —— 不再出现「冷启动 0 模型」。
 * 合并策略：byThread 里出现过的最新 configOptions 优先（含用户切换后的态），
 *          其余用 bootstrap 兜底；按 id 去重。
 */
rpc.onRequest(CODEX_HOST_REQUEST.modelList, async () => {
  // 0) ★ 路线 C：先等 BYOK 对账完成（幂等）。若本轮真的写入了 patch，
  //    则 HMR 需要短暂时间热加载 ⇒ 等一会儿并**重建 bootstrap 缓存**，让新 provider 立刻可见。
  //    （只读模式/无变化时零成本，不引入额外延迟。）
  const byokRes = await ensureByokSync().catch(() => null);
  if (byokRes && byokRes.written) {
    await sleep(HMR_SETTLE_MS);
    state.bootstrapModels = null;      // 作废旧缓存，强制重建
    state.bootstrapPromise = null;
  }

  // 1) 无条件确保有 bootstrap 模型源（幂等；已就绪时零成本直接返回）
  await ensureBootstrapModels();

  // 1.5) ★ 2026-10-15：拉能力元数据（幂等），失败降级为 null（不阻塞列表）
  await ensureModelCapabilities();

  const models = [];
  const groups = [];
  const push = (list, gs) => {
    for (const m of list ?? []) if (!models.some((x) => x.id === m.id)) models.push(m);
    for (const g of gs ?? []) groups.push(g);
  };

  // 2) 已有 thread 的（可能带用户切换后的 currentValue）优先
  for (const [, rec] of state.byThread) {
    const t = sessionNewToThreadStart({ sessionId: rec.sessionId, configOptions: rec.lastConfigOptions }, HOST_PREFIX);
    push(t.models, t.groups);
  }
  // 3) 兜底：bootstrap
  push(state.bootstrapModels, state.bootstrapGroups);

  // 4) ★ 2026-10-15：把 per-model 能力（ctx/vision/思考档）合并进返回的模型条目。
  //    这是属性缺失的修复点 —— 合并后注入层再把它们透传进 base._models，
  //    VS Code 的 Vfe 即可生成带 maxInputTokens/capabilities/configurationSchema 的 metadata。
  const merged = mergeModelCapabilities(models, state.modelCapabilities);

  const currentModel = models.length ? undefined : undefined;
  LOG("info", `model/list: ${models.length} model(s) from ${state.byThread.size} thread(s)` +
    (state.bootstrapModels ? ` + bootstrap(${state.bootstrapModels.length})` : "") +
    (state.capabilitiesError ? ` [capabilitiesError=${state.capabilitiesError}]` : ` [capability+${merged}]`) +
    (state.bootstrapError ? ` [bootstrapError=${state.bootstrapError}]` : ""));
  // ★★★ V2 补丁 M2（2026-10-16）：返回键名必须遵循官方 ModelListResponse 契约。
  //   血案：桥原返回 `{ models, groups }`，但官方 `ModelListResponse = { data: Model[], nextCursor: string|null }`。
  //   VS Code `codexAgent.ts` L2304 `data.push(...response.data)` ⇒ `response.data` 为 undefined
  //   ⇒ `push(...undefined)` 抛 TypeError；且 L2305 `cursor = response.nextCursor` 为 undefined
  //   ⇒ `do { } while (cursor !== null)` **死循环**（undefined !== null 恒真）。
  //   实测（v2-offline-test.mjs）外部读到 `data` 非数组，而桥 stderr 自认为 "7 model(s)" 成功。
  //   ⇒ "内部成功" ≠ "符合上游契约"。`thread/list` 同类坑此前已修（见其注释），此处属漏改。
  //   修：键名 `models` → `data`；补 `nextCursor: null`（全量一次返回，无分页）。
  //   `groups` 桥自用扩展字段保留（VS Code 不读，无害）。
  //
  // ★★★ V2 补丁 M6（2026-10-16）：元素形状必须遵循官方 `v2/Model` 契约。
  //   血案（复测实测）：桥元素是 `{id:"[\"deepseek-official\",\"deepseek-flash\"]", name:"deepseek-flash"}`
  //   ⇒ `model` / `displayName` 皆 undefined，而官方 `Model` 两者皆**必填**：
  //     `{ id:string, model:string, displayName:string, ... supportedReasoningEfforts, inputModalities, ... }`。
  //   VS Code `codexAgent.ts` 用 `model.displayName` 做展示名、
  //   `toCodexModelSelectionId(modelProvider, model.model)` 做 identifier
  //   ⇒ 形状不符 ⇒ 下拉空白 / 选中被拒。
  //   修：此处（**仅回执边界**）用 `toCodexModels()` 重塑；内部管线（thread/start 回执、
  //   注入层 `_publishAgentInfos`、`translateModelSelectionToDsh` 反解）仍用原始条目，零改动。
  const codexModels = toCodexModels(models);
  return {
    data: codexModels,
    nextCursor: null,
    ...(groups.length ? { groups } : {}),
    ...(currentModel ? { currentModel } : {}),
  };
});

// —— ★ 路线 B：agent 清单（DSH agent preset → VS Code agent picker）
/**
 * 桥自行发现 DSH 的 agent preset，并以 codex 协议回给注入层；
 * 注入层再把它喂给 VS Code 的 `provider.getCustomAgents()`。
 *
 * 返回形态（桥自定义的扩展方法 `agent/list`，注入层消费）：
 *   { agents: [{ id, name, description, order, source, legacy? }], counts }
 */
rpc.onRequest(CODEX_HOST_REQUEST.agentList, async () => {
  try {
    const presets = await ensurePresets();
    LOG("info", `agent/list: ${presets.length} agent(s) ` +
      `[${presets.map((p) => p.id).join(", ")}]` +
      (state.presetsError ? ` [presetsError=${state.presetsError}]` : ""));
    return { agents: presets, counts: state.presetsCounts };
  } catch (e) {
    LOG("warn", `agent/list failed: ${e?.message ?? e}`);
    return { agents: [], error: e?.message ?? String(e) };
  }
});

// —— 技能：DSH 无此 RPC，桥扫 DSH 真实技能目录（~/.agents/skills、<proj>/.dsh/skills 等）合成
rpc.onRequest(CODEX_HOST_REQUEST.skillsList, async (params) => {
  const cwds = params?.cwds ?? [args.cwd ?? process.cwd()];
  try {
    const res = await buildSkillsList(cwds, {
      profile: args.profile ?? "acp",
      dshHome: args["dsh-home"],
      agentsHome: args["agents-home"],
    });
    LOG("info", `skills/list: ${res.data.reduce((n, g) => n + g.skills.length, 0)} skills across ${res.data.length} cwd(s)`);
    return res;
  } catch (e) {
    LOG("warn", `skills/list failed: ${e?.message ?? e}`);
    return buildSkillsListResult(cwds, []);
  }
});

// —— hooks/list：★ 2026-10-16 显式实现（原走 IMPL_FALLBACK 只回 `{data:[]}`）
//   权威 `HooksListEntry` required = `["cwd","errors","hooks","warnings"]`。
//   DSH 无 hook 概念 ⇒ 对每个请求 cwd 恒返回**合法空条目**（语义 = "该目录无 hook"），
//   让 VS Code 的 hook 面板与 `_buildSessionHookTrustState` 拿到结构完整的 data。
rpc.onRequest(CODEX_HOST_REQUEST.hooksList, async (params) => {
  const cwds = params?.cwds ?? [args.cwd ?? process.cwd()];
  const res = buildHooksListResult(cwds);
  LOG("info", `hooks/list: ${res.data.length} cwd(s), 0 hook(s) (契约合规空条目)`);
  return res;
});

// —— MCP 清单：读 DSH profile 里 dsh-mcp-client 插件声明的 server 条目
rpc.onRequest(CODEX_HOST_REQUEST.mcpServerStatusList, async () => {
  try {
    const { servers } = await discoverMcpServers(args.profile ?? "acp", {
      dshHome: args["dsh-home"],
    });
    // ★ T4：桥在报告 MCP 清单后，**同步上报每个 server 的启动态**
    //   （codex 契约：mcpServer/startupStatus/updated {threadId?, name, status, error?}）。
    //   桥只做静态上报（真实连接态由 DSH 进程持有），故 status 统一为 "configured"。
    //   注入层 reflow 目前不消费该通知（无 UI 需求时静默），但补齐后**协议面与参照系对称**。
    for (const s of servers) {
      try {
        rpc.notify(CODEX_NOTIFICATION.mcpServerStartupStatusUpdated, { name: s.name, status: "configured" });
      } catch (_) { /* 通知失败不影响列表返回 */ }
    }
    LOG("info", `mcpServerStatus/list: ${servers.length} server(s)`);
    // ★★★ V2 补丁 M4（2026-10-16）：键名与元素形状必须遵循官方 ListMcpServerStatusResponse 契约。
    //   血案：桥原返回 `{ mcpServers: [...] }`，但官方契约是
    //     `ListMcpServerStatusResponse = { data: McpServerStatus[], nextCursor: string|null }`。
    //   VS Code 消费点（codexAgent.ts L8371-8380）：
    //     `data = data.concat(response.data ?? [])`  ← data 缺失即恒空（MCP 面板全空）
    //     `cursor = response.nextCursor; while (cursor)` ← nextCursor 恒 undefined 则单轮退出（不致死循环）
    //   ⇒ 后果：**MCP 服务器清单永远为空**（比 model/list 温和，但功能缺失）。
    //   同时元素形状也不符：`McpServerStatus` 必填 13 字段（name/runtimeStatus/serverInfo/
    //   serverCapabilities/tools/toolsError/resources/resourceTemplates/authStatus/...），
    //   桥原来只给 name/transport/command/args/url/status/source —— 缺 `runtimeStatus`、
    //   `tools`、`resources`、`authStatus` 等必填项，VS Code 的 `codexMcpListToInventory`
    //   会读到 undefined。修：按官方契约补全元素字段（桥只做**静态上报**，故工具/资源清单为空、
    //   连接态按 DSH 配置推断；真实连接态由 DSH 进程持有，此处如实标注 "notStarted"）。
    return {
      data: servers.map((s) => ({
        name: s.name,
        // ★ 连接态（官方枚举 "notStarted"|"starting"|"connected"|...）：桥为静态上报，
        //   恒 "notStarted"（= 已配置但本桥未建立连接）。原来误用 "configured" —— 非合法枚举值。
        runtimeStatus: "notStarted",
        pluginId: null,
        httpOrigin: s.url ? (() => { try { return new URL(s.url).origin; } catch { return null; } })() : null,
        serverInfo: null,          // 未初始化 ⇒ 无呈现元数据
        serverCapabilities: null,  // 未初始化 ⇒ 无能力声明
        tools: {},                 // 静态上报 ⇒ 工具清单空（VS Code 有 `?? {}` 兜底）
        toolsError: null,
        resources: [],
        resourceTemplates: [],
        authStatus: "unknown",     // 桥不持有凭据 ⇒ unknown
        // —— 以下为桥自用扩展（VS Code 不读，供诊断/未来 UI）
        _bridge: { transport: s.transport, command: s.command, args: s.args, url: s.url, source: s.source },
      })),
      nextCursor: null,
    };
  } catch (e) {
    LOG("warn", `mcpServerStatus/list failed: ${e?.message ?? e}`);
    return { data: [], nextCursor: null };
  }
});

/**
 * ★ 自愈闸门 ①：确保 DSH 子进程活着且已握手。
 *
 * 血案（2026-10-11，与 bootstrap 同源）：VS Code 侧日志出现
 *   `[ProtocolServer] Client disconnected: ...` 紧接 `bridge timeout: thread/start`。
 *   桥进程自身没死，但**桥→DSH 的 stdio 通道已断**（子进程退出 / 管道关闭），
 *   此时任何 `dsh.*` 请求都会永久 pending ⇒ 注入片段等满 120s。
 *   ⇒ 修：在**每个**对外请求入口先做活性检查，子进程死了就地重建 + 重新握手。
 */
async function ensureDshAlive() {
  if (dsh.child && !dsh.closed) return;
  LOG("warn", "dsh channel dead; re-spawning + re-initializing");
  await dsh.dispose();   // 优雅关停旧进程（可能已在退出中，dispose 幂等）
  state.initialized = false;
  state.startPromise = null;       // ★ M7：作废旧闸门，强制走新通道
  state.bootstrapPromise = null;   // 让 bootstrap 用新通道重建
  state.bootstrapModels = null;
  await ensureDshReady();          // ★ M7：复用串行化闸门（唯一 spawn 入口）
}

// —— 会话：thread/start → session/new
rpc.onRequest(CODEX_HOST_REQUEST.threadStart, async (params) => {
  await ensureDshAlive();
  const newParams = threadStartToSessionNew(params);
  // ★ 工作目录可观测（真机排障 + e2e 判据）：明确记录本次 thread 实际使用的 cwd，
  //   以及它是「调用方显式传入」还是「回落进程静态 cwd」——这是排查
  //   「worktree 会话未落到 worktree 目录」类问题的第一现场。
  const cwdSource = params?.cwd != null ? "params.cwd"
    : (params?.workingDirectory != null ? "params.workingDirectory" : "process.cwd(fallback)");
  LOG("info", `thread/start: cwd=${newParams.cwd} (source=${cwdSource})`);
  // ★★★ 模型可观测（2026-10-16）：VS Code 确实在 thread/start 带了 model/modelProvider
  //   （codexAgent.ts:5078-5079），旧实现丢弃它们 ⇒ DSH 会话无模型 ⇒ 用户选择"不生效"。
  //   现将原始入参打进日志：这是排查「模型是否传到桥」的唯一第一现场。
  LOG("info", `thread/start: model=${JSON.stringify(params?.model ?? null)} provider=${JSON.stringify(params?.modelProvider ?? null)}`);
  // VS Code 未显式带 mcpServers 时，回落用 DSH profile 里声明的（技能/MCP 同源串通）
  if (!newParams.mcpServers || newParams.mcpServers.length === 0) {
    newParams.mcpServers = await dshMcpServers();
  }
  const res = await dsh.newSession(newParams);
  // ★★★ 模型回显（2026-10-16）：无论是否收到 model，都把「桥收到什么 / DSH 当前生效什么」
  //   一次性打进日志。此前 `if (newParams.__model)` 分支才打日志 ⇒ **没收到模型时静默**，
  //   导致「用户说选了 ds4.1，日志却看不出桥收到了什么」。现在恒打，是排查模型链路的第一现场。
  {
    // ★ 字段名铁律：DSH `configOptions` 是**数组**，当前值在 `opt.currentValue`
    //   （**不是** `res.configOptions.model` —— 首版这么读 ⇒ 恒打 `DSH生效=null`，
    //    把"读取方式错"误报成"DSH 没设上模型"，是比不打日志更坏的误导）。
    //   复用 `translateConfigOptionsToModels()` 的 `currentModel`（与 model/list 同源口径），
    //   保证「日志里看到的生效模型」== 「VS Code 实际拿到的清单当前值」。
    let echoModel = null;
    try {
      const t = translateConfigOptionsToModels(res?.configOptions, HOST_PREFIX);
      echoModel = t?.currentModel ?? null;
    } catch { /* 观测代码绝不影响主流程 */ }
    LOG("info", `thread/start: ◆ 模型回显 收到=${JSON.stringify(newParams.__model ?? null)}` +
      ` provider=${JSON.stringify(newParams.__modelProvider ?? null)}` +
      ` DSH生效=${JSON.stringify(echoModel)} (session=${String(res.sessionId).slice(-12)})`);
  }
  state.byThread.set(res.sessionId, {
    sessionId: res.sessionId,
    cwd: newParams.cwd,          // ★ 记录，便于诊断/断言的即时读取
    cwdSource,
    lastConfigOptions: res.configOptions,
    currentTurnId: null,
    // ★ 记录本会话请求的模型（供 thread/read、诊断与「模型是否落地」断言使用）
    requestedModel: newParams.__model ?? null,
    requestedModelProvider: newParams.__modelProvider ?? null,
  });

  // ★★★ 模型落地（2026-10-16 新增）—— 修「用户选了模型但 DSH 用的是默认模型」。
  //
  // 【证据链】VS Code `thread/start` 携带 `model` + `modelProvider`（codexAgent.ts:5078/5705）；
  //   旧实现把这俩丢弃 ⇒ DSH 会话无模型。
  // 【修法】会话建好后**立即**用 `session/set_config_option` 下发。
  //   ★ 必须在 session/new 之后（ACP 的 session 级配置只能对已存在的 session 设置）。
  // 【失败必须可见】此前这类失败只 `LOG("warn")` 然后继续 —— 用户完全无感。
  //   现在：记入 `state.modelSyncError`，并让**下一轮 turn/start 前**把它作为可读错误抛出
  //   （宁可让用户知道"模型没设上"，也不要静默用错模型跑）。
  if (newParams.__model) {
    const catalog = state.bootstrapModels ?? [];
    const resolvedValue = resolveDshModelValue(newParams.__model, newParams.__modelProvider, catalog);
    if (!resolvedValue) {
      const msg = `无法把模型 ${JSON.stringify(newParams.__model)} 解析为 DSH 模型值`;
      state.modelSyncError = msg;
      LOG("error", `[flow] ! MODEL ${msg}（provider=${JSON.stringify(newParams.__modelProvider)}，` +
        `清单 ${catalog.length} 项）⇒ 本会话将使用 DSH 默认模型；用户所选模型不生效`);
      // ★ 可观测（2026-10-16）：把候选清单全量打出，便于判断「是没收到」还是「收到了但解析不到」。
      //   ★ 字段名铁律：模型条目的字段是 `{provider, name, id, rawValue}` ——
      //     **没有 `value`**（血案：首版写成 `${m.provider}/${m.value}` ⇒ 全打印 `undefined`，
      //     等于白打）。改用 `name`（人类可读）并在需要时附 `rawValue`。
      try {
        LOG("error", `[flow] ! MODEL 候选清单=${JSON.stringify(catalog.map((m) => `${m.provider}/${m.name ?? m.id}`))}`);
      } catch { /* 忽略 */ }
    } else {
      try {
        const r6 = await dsh.setConfigOption(res.sessionId, "model", resolvedValue);
        // ★★★ 回读校验（2026-10-16，修「选 A 跑 B」）：
        //   此前只判「调用没抛异常」就宣称"已落地" —— 那是**乐观假设**。
        //   血案：日志同时打出 `★ 模型已落地 ["bumen","deepseek-v4.1-flash"]`
        //   与 `DSH生效=["lobsterai-custom-0","Qwen3.8-Flash-AI"]`，
        //   两者矛盾却无人察觉 ⇒ 用户选了 DS4.1 实际跑 Qwen3.8。
        //   现在：以 DSH **回执的 configOptions** 为准，不匹配即报错。
        let back = null;
        try {
          const t2 = translateConfigOptionsToModels(r6?.configOptions, HOST_PREFIX);
          back = t2?.currentModel ?? null;
        } catch { /* 忽略 */ }
        const applied = back !== null && JSON.stringify(back) === JSON.stringify(resolvedValue);
        state.modelSyncError = null;
        const rec = state.byThread.get(res.sessionId);
        if (rec) { rec.appliedModel = resolvedValue; rec.configOptionsAfterApply = r6?.configOptions; }
        LOG("info", `thread/start: ★ 模型已落地 ${resolvedValue} (session=${res.sessionId.slice(-12)})` +
          ` [DSH回读=${JSON.stringify(back)} ${applied ? "✅校验通过" : "❌校验不通过"}]`);
      } catch (e) {
        const msg = `设置会话模型失败（${resolvedValue}）：${e?.message ?? e}`;
        state.modelSyncError = msg;
        LOG("error", `[flow] ! MODEL ${msg}`);
      }
    }
  }
  // ★ 路线 B：记录本会话选中的 agent（preset）。VS Code 侧选中项经 thread/start 的
  //   `agent` / `agentId` 字段传入（注入层从 provider.setAgent 捕获后透传）。
  const agentId = params?.agent ?? params?.agentId ?? params?.preset;
  if (agentId) {
    state.presetByThread.set(res.sessionId, String(agentId).replace(/^agent:/, ""));
    LOG("info", `thread/start: agent/preset selected = ${agentId} (session=${res.sessionId.slice(-12)})`);
  }
  // ★★ 症状②完整性（2026-10-15，方案 D）：新建会话**必须继承**当前档位。
  //   血案：DSH session pin 把档位在 session 创建时永久写死；若用户此前已选「允许全部」，
  //   之后新开的会话仍拿 pinned 默认档（workspace-write）⇒ 症状②复现。
  //   修：新会话一建好就直调扩展方法把它拉到 `state.permissionMode`。
  //   仅当档位已偏离 DSH 部署默认（即用户显式选过）才动，避免无谓调用。
  if (state.permissionMode && state.permissionMode !== DSH_DEFAULT_MODE) {
    try {
      const r = await dsh.sandboxSetMode(res.sessionId, state.permissionMode);
      if (r === null) {
        LOG("info", `thread/start: 对端无 _bowei 扩展 ⇒ 新会话沿用 patch 默认档（需重启会话生效）`);
      } else {
        LOG("info", `thread/start: ★ 新会话已继承档位 ${state.permissionMode} (session=${res.sessionId.slice(-12)})`);
      }
    } catch (e) {
      LOG("warn", `thread/start: 新会话继承档位失败（${e?.code ?? "?"} ${e?.message ?? e}）`);
    }
  }
  // ★★★ 契约统一（2026-10-16）：把本会话真实 cwd 透传进应答。
  //   权威 `Thread.cwd` 是 required（AbsolutePathBuf）；此前未传 ⇒ `thread.cwd = undefined`
  //   ⇒ VS Code 任何读 `res.thread.cwd` 的点都会崩（工作目录/检查点/多根判定等）。
  return sessionNewToThreadStart({ sessionId: res.sessionId, configOptions: res.configOptions, cwd: newParams.cwd }, HOST_PREFIX);
});

// —— thread/resume → session/resume
rpc.onRequest(CODEX_HOST_REQUEST.threadResume, async (params) => {
  await ensureDshAlive();
  let mcp = params?.mcpServers ?? [];
  if (!mcp.length) mcp = await dshMcpServers();
  const sid = params?.threadId ?? params?.sessionId;
  const prev = state.byThread.get(sid);
  const resumeCwd = params?.cwd ?? args.cwd ?? prev?.cwd ?? process.cwd();

  // ★★★ 幂等自愈（2026-10-16 修 `CodexResumeFailed: session is already active`）
  //
  // 【症状】报错后该会话**再也发不出消息**（VS Code 把 chat 标记为 resume 失败并停用发送）。
  //
  // 【机制】`already active` 意味着**会话本来就是活的** —— 而 resume 的**唯一目的**
  //   就是「让它可用于随后的 turn/start」。目的已达成 ⇒ 这是**好消息，不是失败**。
  //   VS Code 会先发 `thread/unsubscribe`；但该语义只是「本 app-server 释放订阅」，
  //   **不要求后端销毁会话**（对照 codexAgent.ts:6895 起）。我们的桥把会话托管给 DSH
  //   长驻进程、unsubscribe 又是空实现 ⇒ 会话在 DSH 侧仍 active ⇒ resume 被拒。
  //
  // 【修法】命中幂等文案 ⇒ 当成功处理：登记/沿用 byThread 记录，直接返回合法 Thread，
  //   让上游继续走 turn/start。**绝不上抛**（上抛的代价是用户会话永久卡死）。
  //   同源范式：VS Code `_replaceMissingRolloutBacking()` 对 `no rollout found` 也是
  //   `return {}` 而非抛出。
  let res = null;
  try {
    res = await dsh.resumeSession({
      sessionId: sid,
      cwd: resumeCwd,
      mcpServers: mcp,
    });
  } catch (e) {
    const idem = asIdempotent(e);
    if (!idem.idempotent) throw e;      // 真失败（cwd 不符 / 会话不存在…）⇒ 照常上抛
    LOG("info", `[flow] · thread/resume 幂等命中（${idem.reason}）⇒ 会话本已 active，按成功继续 ` +
      `session=${String(sid).slice(-12)}；不向 UI 报错（原行为会让该会话永久无法发送）`);
  }
  state.byThread.set(sid, {
    sessionId: sid,
    cwd: resumeCwd,
    cwdSource: params?.cwd != null ? "params.cwd" : (prev?.cwdSource ?? "resume-fallback"),
    lastConfigOptions: res?.configOptions ?? prev?.lastConfigOptions,
    currentTurnId: prev?.currentTurnId ?? null,
  });
  // ★★★★ 模型落地（2026-10-16 二次定案）—— 修「恢复的会话不设模型」。
  //
  // 【症状】用户在下拉里换了模型，对**已存在的会话**发消息，模型不生效；
  //   真机表现为报错文案与实际所选 provider **完全对不上**（例：选 bumen 却报 jxbw 的 403）。
  //
  // 【机制】`thread/start` 有完整的模型落地段（见该 handler 的「模型落地」注释），
  //   但 `thread/resume` **只拉了权限档位（sandboxSetMode），一行模型逻辑都没有**。
  //   而 VS Code 对「已存在的 chat」走的是 resume 路径
  //   （`_createResumedSessionEntry` / `resumeChat`），thread/start 只在**新建**时走。
  //   ⇒ 凡是「prewarm 抢先建好会话 → 用户在已有会话上换模型」的场景，
  //     `set_config_option` **从未被调用** ⇒ DSH 会话保持 pinned 默认
  //     （本机 = `["lobsterai-custom-0","Qwen3.8-Flash-AI"]`，走 jxbw 网关）
  //     ⇒ 用户看到的报错属于**另一个 provider**，与所选模型无关 —— 排查时极易误判。
  //
  // 【与 thread/start 的差异】resume 的 `params` 同样携带 `model`/`modelProvider`
  //   （VS Code 的 `resumeChat` 复用同一 chat 配置），故落地逻辑可完全对齐。
  //   同样做**回读校验**（不信"调用没抛异常"），失败写入 `state.modelSyncError`
  //   由下一轮 turn/start 前抛出，绝不静默。
  const resumeModel = params?.model;
  if (resumeModel) {
    const catalog = state.bootstrapModels ?? [];
    const resolvedValue = resolveDshModelValue(resumeModel, params?.modelProvider, catalog);
    if (!resolvedValue) {
      const msg = `无法把模型 ${JSON.stringify(resumeModel)} 解析为 DSH 模型值`;
      state.modelSyncError = msg;
      LOG("error", `[flow] ! MODEL(resume) ${msg}（provider=${JSON.stringify(params?.modelProvider)}，` +
        `清单 ${catalog.length} 项）⇒ 本会话将使用 DSH 默认模型；用户所选模型不生效`);
    } else {
      try {
        const rr = await dsh.setConfigOption(sid, "model", resolvedValue);
        let back = null;
        try {
          const tt = translateConfigOptionsToModels(rr?.configOptions, HOST_PREFIX);
          back = tt?.currentModel ?? null;
        } catch { /* 忽略 */ }
        const applied = back !== null && JSON.stringify(back) === JSON.stringify(resolvedValue);
        state.modelSyncError = null;
        const rec2 = state.byThread.get(sid);
        if (rec2) { rec2.appliedModel = resolvedValue; rec2.configOptionsAfterApply = rr?.configOptions; }
        LOG("info", `thread/resume: ★ 模型已落地 ${resolvedValue} (session=${String(sid).slice(-12)})` +
          ` [DSH回读=${JSON.stringify(back)} ${applied ? "✅校验通过" : "❌校验不通过"}]`);
      } catch (e) {
        const msg = `恢复会话时设置模型失败（${resolvedValue}）：${e?.message ?? e}`;
        state.modelSyncError = msg;
        LOG("error", `[flow] ! MODEL(resume) ${msg}`);
      }
    }
  } else {
    LOG("info", `thread/resume: 本次未携带 model（沿用 DSH 会话当前模型）session=${String(sid).slice(-12)}`);
  }
  // ★ 同 thread/start：恢复的会话也要拉到当前档位（session pin 同样适用）
  if (state.permissionMode && state.permissionMode !== DSH_DEFAULT_MODE) {
    try {
      const r = await dsh.sandboxSetMode(sid, state.permissionMode);
      if (r !== null) LOG("info", `thread/resume: ★ 已把会话档位拉齐到 ${state.permissionMode} (session=${sid.slice(-12)})`);
    } catch (e) {
      LOG("warn", `thread/resume: 拉齐档位失败（${e?.code ?? "?"} ${e?.message ?? e}）`);
    }
  }
  // ★ 契约统一（2026-10-16）：cwd 必填，从 params 取（resume 已在前文解析）
  // ★ 幂等路径（res=null）时，configOptions 必须回落到**刚登记进 byThread 的值**
  //   （即 prev 的），否则 VS Code 的模型清单会因 `models: []` 而变空 / 回丢失态。
  return sessionNewToThreadStart({
    sessionId: sid,
    configOptions: res?.configOptions ?? state.byThread.get(sid)?.lastConfigOptions,
    cwd: state.byThread.get(sid)?.cwd ?? params?.cwd ?? args.cwd ?? process.cwd(),
  }, HOST_PREFIX);
});

// —— thread/list → session/list
/**
 * ★★★ 血案修复 v2（2026-10-15，`sourceUnresolvable` 全会话不可见的**上游契约错误**）：
 *
 *   【v1 的错误】v1 认为「VS Code 期望 `${providerId}:/${sessionId}` 形态的 id」
 *     ⇒ 给 DSH 裸 id 补 `dsh:/` 前缀、且把结果塞进 `{ threads: [...] }`。
 *
 *   【实测推翻】直接阅读 main bundle 的 `thread/list` 消费点（`sessionsDiscoveryScan`）：
 *     · 请求参数：`{ limit:100, modelProviders:[], cursor?, useStateDbOnly, sortKey:"updated_at" }`
 *     · 响应契约：`{ data: [...], nextCursor?: string }` —— **读的是 `g.data`，不是 `threads`**！
 *       分页助手 `cQ` 最多 50 页，把 `params.cursor` 回传，`nextCursor === undefined` 即终止。
 *     · 每个 item 被消费的字段（`_threadToMetadata` 逐项读）：
 *         id / createdAt(秒) / updatedAt(秒) / name / preview / cwd
 *         / source / path / modelProvider / parentThreadId
 *     · VS Code 侧自己拼 URI：`L.uri(this.id, p.id)` ⇒ `dsh:/<p.id>`（**p.id 必须是裸 id**）。
 *       实证（`agentSessionData/f676a5f8-.../session.db` 的 `chat_drafts.chat_uri`）：
 *         base64 解码 = `dsh:/f676a5f8-e0e2-4c2e-96d8-84fd844ff29f`
 *         ⇒ VS Code 用**裸 id** `f676a5f8-...` 当会话目录名，并自拼 `dsh:/` 前缀。
 *     · 时间戳单位：`_threadToMetadata` 做 `(e.createdAt ?? 0) * 1e3` ⇒ **入参必须是"秒"**。
 *
 *   【双重错误后果】返回 `{ threads }` ⇒ VS Code 读到 `g.data` = undefined ⇒ `.length` 抛错
 *     或空 ⇒ 远端会话清单**永远为空** ⇒ catalog 里的 dsh 行无法被 reconcile 确认
 *     ⇒ 落到 `getChatMetadata`（返回 undefined）⇒ `sourceUnresolvable` ⇒ 会话列表不显示。
 *
 *   【v2 修法】严格按上游契约输出：`{ data: [...], nextCursor }`，
 *     裸 id、秒级时间戳、字段映射；透传 cursor 分页（DSH `session/list` 支持 nextCursor）。
 */
rpc.onRequest(CODEX_HOST_REQUEST.threadList, async (params) => {
  try {
    const limit = Number(params?.limit) > 0 ? Number(params.limit) : 100;
    const cursor = params?.cursor ?? undefined;

    // ★ 透传分页：把 VS Code 的 cursor 交给 DSH（字段名对齐 ACP 语义；DSH 不收则忽略）
    const req = { limit };
    if (cursor !== undefined) req.cursor = cursor;
    const res = await dsh.listSessions(req);
    const raw = res?.sessions ?? [];

    // ★★★ 2026-10-16 血案修复（会话列表重启即"丢失"）：
    //   DSH 的 `session/list` **只回 `{sessionId, cwd}`**（其 acp 第 1509-1512 行逐字 map 出的
    //   就是这两个字段），**不返回任何时间戳** ⇒ 下面 `toSec(...) ?? nowSec` 会让**全部会话
    //   拿到同一个 "现在"**（实测 100 条 createdAt 唯一值 = 1）⇒ VS Code 排序键全等
    //   ⇒ 列表顺序不确定、每次重启重算 nowSec ⇒ 表现为"会话列表内容丢失/乱序"。
    //   修：从 DSH 自己的会话存储（只读）批量补齐真实 createdAt/updatedAt。
    const tsIndex = await readSessionTimestampIndex({ dshHome: args["dsh-home"] });

    const nowSec = Math.floor(Date.now() / 1000);
    const data = raw.map((s) => {
      // ★ 裸 id（绝不加 `dsh:/` 前缀，也不保留 DSH 的 `session-` 前缀——VS Code 自拼）
      let id = s.sessionId ?? s.id ?? s.threadId;
      if (id == null) return null;
      id = String(id).replace(/^session-/, "");       // 兼容个别 DSH 版本的 session-<uuid> 形态
      // 时间戳：DSH 可能给 ISO / 秒 / 毫秒，统一归一到**秒**
      const toSec = (v) => {
        if (v == null) return undefined;
        if (typeof v === "number") return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v); // 毫秒→秒
        const t = Date.parse(String(v));
        return Number.isFinite(t) ? Math.floor(t / 1000) : undefined;
      };
      // ★ 优先 ACP 给的时间戳（假若将来 DSH 补上）；否则用**存储侧真值**；最后才 nowSec。
      const fromStore = tsIndex.get(id);
      const createdAt = toSec(s.createdAt ?? s.created_at ?? s.created)
        ?? (fromStore ? Math.floor(fromStore.createdAtMs / 1000) : undefined)
        ?? nowSec;
      const updatedAt = toSec(s.updatedAt ?? s.updated_at ?? s.updated ?? s.mtime)
        ?? (fromStore ? Math.floor(fromStore.updatedAtMs / 1000) : undefined)
        ?? createdAt;
      const cwd = s.cwd ?? s.workingDirectory ?? args.cwd;
      const name = s.name ?? s.title ?? s.summary ?? undefined;
      const preview = s.preview ?? s.firstUserMessage ?? undefined;
      // ★★★ 契约统一（2026-10-16）：`ThreadListResponse.data[]` 的元素类型就是 `Thread`
      //   （权威 schema: `data.items.$ref = "#/definitions/Thread"`），与 thread/start、thread/read
      //   消费**同一套 13 个 required 字段**。此前只手拼 5~8 个字段 ⇒ 上游读到 `undefined.xxx` 崩溃。
      //   修：一律走 `toCodexThread()` 唯一真源；桥特有的补充（name/preview/path）由它统一承载。
      return toCodexThread(id, {
        createdAt: createdAt,            // ★ 权威定义：Thread.createdAt 是 **Unix 秒**
        updatedAt: updatedAt,            // ★ 同上（原误写 *1000，已按 schema 描述纠正）
        cwd,
        name,
        preview: preview ?? "",
        status: "idle",
        source: s.source ?? "vscode",    // SessionSource: cli|vscode|exec|appServer|unknown
        modelProvider: s.modelProvider ?? "openai",
        ephemeral: s.ephemeral === true,
      });
    }).filter(Boolean);

    const nextCursor = res?.nextCursor ?? undefined;
    LOG("info", `thread/list: ${data.length} thread(s) (data 契约; nextCursor=${nextCursor ? "有" : "无"}; cursor=${cursor ? "有" : "无"})`);
    // ★★★ V2 补丁 M2b + M3（2026-10-16）：契约字段必须**恒存在**，且值与类型严格。
    //   血案（M2b，与 model/list 同款）：原 `...(nextCursor !== undefined ? { nextCursor } : {})`
    //     ⇒ DSH 不分页时字段**整个缺失** ⇒ VS Code `cursor = response.nextCursor` = undefined
    //     ⇒ `do { } while (cursor !== null)` **死循环**（undefined !== null 恒真）。
    //     修：nextCursor 恒定输出，缺省 `null`（官方契约 `string | null`）。
    //   血案（M3）：官方 `ThreadListResponse` 三字段 `{data, nextCursor, backwardsCursor}` 全必填，
    //     而桥从不返回 backwardsCursor。该字段语义 = "反向翻页锚点"（同秒更新不漏项）。
    //     VS Code 消费点：`sortDirection` 反转时用作 `cursor`。桥不实现反向排序
    //     ⇒ 恒返回 `null`（契约允许），表示"无反向锚点"，VS Code 优雅降级为不反向翻页。
    return {
      data,
      nextCursor: nextCursor ?? null,
      backwardsCursor: null,
    };
  } catch (e) {
    LOG("warn", `session/list failed: ${e?.message ?? e}`);
    return { data: [], nextCursor: null, backwardsCursor: null };
  }
});

// —— thread/read → 会话元数据（VS Code 恢复历史 chat 时必调）
//    ★★★ 血案（2026-10-11）：此前只声明未实现 ⇒ 恢复历史会话时上游抛
//    `Session was never created on the backend` 刷屏。这里对**未知 session 也返回合法空 thread**，
//    让它优雅降级（等价于"会话存在但暂无轮次"），历史会话随后由 thread/resume 真正拉活。
//
//    ★★★★★ 血案 2（2026-10-16）：**点开会话右侧全空白**。
//    根因：此处 `await dsh.listTurns?.(sid)` —— `dsh-acp-client.mjs` **没有 listTurns**
//    ⇒ 可选链短路 ⇒ `turns` 恒 `[]` ⇒ VS Code 日志逐字 `Restored session ... with 0 turns`。
//    ★ 而且 ACP 侧**也拿不到历史**：已装 `@deepseek-ai/dsh-acp` 只实现
//      `session/{new,list,resume,close,set_config_option,prompt,cancel,update,event}`，
//      **无 `session/load`**，`session/list` 回执也只有 `{sessionId,cwd}`。
//    ⇒ 唯一出路：读 DSH **落盘转录**（见 transcript.mjs 头部说明）。
rpc.onRequest(CODEX_HOST_REQUEST.threadRead, async (params) => {
  const sid = params?.threadId ?? params?.sessionId;
  const includeTurns = params?.includeTurns !== false;
  if (!sid) return threadReadResult("", { turns: [] });
  const rec = state.byThread.get(sid);
  const cwd = rec?.cwd ?? params?.cwd ?? args.cwd;

  // ★ 历史回填：从 DSH 落盘转录读取并翻译成 codex Turn[]
  //   ★ 未知 session（byThread 无记录）**也要读** —— 恢复历史会话时 VS Code 先 cold-read，
  //     此时 byThread 往往为空（尚未 resume）。这正是"点开空白"的关键场景。
  let turns = [];
  if (includeTurns) {
    turns = await loadHistoryTurns(sid, cwd);
  }
  return threadReadResult(sid, {
    cwd,                                         // ★ 优先会话真实 cwd，回落桥启动 cwd
    turns,
    status: rec?.currentTurnId ? "active" : "idle",
  });
});

/**
 * 读取某会话的历史轮次（带进程内缓存 + 转录文件 mtime 失效判定）。
 *
 * ★ 为什么必须缓存：实测 `thread/read` 一次会话被调 **1115 次**（VS Code 高频拉取）。
 *   而最大实测转录 **12.7MB / 20,726 记录**，解压一次 **~1.25s**。
 *   若每次都重解 ⇒ UI 直接卡死。
 *   缓存键 = `sessionId`；失效判据 = 转录文件 `mtimeMs` 变化（DSH 每写一批就 append 一帧
 *   ⇒ mtime 必变 ⇒ 能正确感知"本轮新消息"）。
 */
const _historyCache = new Map();   // sessionId → { mtimeMs, size, turns, path, at }

/** 转录仍在增长时，强制复读的最短间隔（ms）。避免 1115 次突发调用把 12.7MB 解压 1115 遍。 */
const HISTORY_MIN_REREAD_MS = 2000;
/** 转录超过此大小才启用"复读节流"（小文件解压仅几 ms，无需节流，保证实时性）。 */
const HISTORY_THROTTLE_BYTES = 1_000_000;

async function loadHistoryTurns(sessionId, cwd, opts = {}) {
  try {
    // ★★ 先解析**路径**并 stat（廉价），命中缓存就**完全不读文件**。
    //   血案：最初把 stat 放在 readTranscript **之后** ⇒ 每次都先把 12.7MB 读完解压
    //   （~1.2s）才发现缓存可用 ⇒ 缓存形同虚设。**顺序反了**。
    const tpath = await resolveTranscriptPathCI(sessionId, cwd, opts);
    if (!tpath) {
      LOG("info", `thread/read: 无转录文件 session=${String(sessionId).slice(-12)} (cwd=${cwd ?? "?"})`);
      return [];
    }
    let st = null;
    try { st = await fspStat(tpath); } catch { /* 忽略 */ }
    const mtimeMs = st?.mtimeMs ?? 0;
    const size = st?.size ?? 0;
    const now = Date.now();

    const hit = _historyCache.get(sessionId);
    if (hit && hit.path === tpath) {
      // ① 完全没变（mtime+size 一致）⇒ 直接复用
      const unchanged = hit.mtimeMs === mtimeMs && hit.size === size && mtimeMs !== 0;
      // ② 大文件且刚读过不久 ⇒ 节流复用（转录可能正在追加，但 2s 内的重复调用没必要重解）
      const throttled = !unchanged
        && size >= HISTORY_THROTTLE_BYTES
        && (now - (hit.at ?? 0)) < HISTORY_MIN_REREAD_MS;
      if (unchanged || throttled) {
        LOG("info", `thread/read: 历史缓存命中(${unchanged ? "未变化" : "节流"}) ` +
          `${hit.turns.length} turn session=${String(sessionId).slice(-12)}`);
        return hit.turns;
      }
    }

    const t1 = Date.now();
    const { records, error } = await readTranscriptFile(tpath);
    if (error) LOG("warn", `thread/read: transcript 读取异常 session=${String(sessionId).slice(-12)}: ${error}`);
    if (!records.length) {
      _historyCache.set(sessionId, { mtimeMs, size, turns: [], path: tpath, at: now });
      return [];
    }
    const { events } = extractConversationEvents(records);
    /**
     * ★★★ 2026-10-17：**权威轮次边界 + 轮次打标**。
     *   ① `extractTurnBoundaries`：读 `turn/start`/`turn/end` 真值（含 reason.kind）；
     *   ② `tagEventsWithTurn`：用边界 seq 区间给 user 事件补 DSH 轮次号
     *      （user/message 的 turn 恒为 null，必须补）；
     *   ⇒ `transcriptEventsToTurns` 据此**按轮次号分组**（而非"user+assistant 顺序配对"）。
     *   血案：顺序配对在"一轮含多条 assistant/user"的长 agentic 轮上过分裂
     *   （实测 5 轮被拆成 17 轮）；实测一轮最多 15 条 assistant/message。
     */
    let boundaries = null, tagged = events;
    try {
      const { extractTurnBoundaries, tagEventsWithTurn } = await import("./transcript.mjs");
      boundaries = extractTurnBoundaries(records);
      tagged = tagEventsWithTurn(events, records);
    } catch (e) {
      LOG("warn", `thread/read: 边界/打标失败（回落配对）session=${String(sessionId).slice(-12)}: ${e?.message ?? e}`);
    }
    const turns = events.length
      ? transcriptEventsToTurns(tagged, { threadId: sessionId, boundaries })
      : [];
    _historyCache.set(sessionId, { mtimeMs, size, turns, path: tpath, at: Date.now() });
    const bndInfo = boundaries
      ? `边界: ${boundaries.turns.length}轮 lastTurn=${boundaries.lastTurn} open=${boundaries.openTurn ?? "无"}` +
        (boundaries.lastStepBoundary ? ` 末步=${boundaries.lastStepBoundary.turn}/${boundaries.lastStepBoundary.step}(${boundaries.lastStepBoundary.kind})` : "")
      : "边界: 无";
    LOG("info", `thread/read: ★ 历史回填 ${turns.length} turn / ${events.length} msg ` +
      `(${Date.now() - t1}ms, ${(size / 1024).toFixed(0)}KB) ${bndInfo} session=${String(sessionId).slice(-12)}`);

    // 容量控制：超 64 个会话则淘汰最旧的一半（Map 保持插入序）
    if (_historyCache.size > 64) {
      let n = 0;
      for (const k of _historyCache.keys()) { _historyCache.delete(k); if (++n >= 32) break; }
    }
    return turns;
  } catch (e) {
    LOG("warn", `thread/read: 历史回填失败 session=${String(sessionId).slice(-12)}: ${e?.message ?? e}`);
    return [];
  }
}

/** 解析转录文件真实路径（字面 → 大小写不敏感 → 全局反查），只做路径解析不读内容 */
async function resolveTranscriptPathCI(sessionId, cwd, opts = {}) {
  const { resolveTranscriptPath } = await import("./transcript.mjs");
  const { readdir, access } = await import("node:fs/promises");
  const { resolveDshHome } = await import("./transcript.mjs");
  const sessionsRoot = `${resolveDshHome(opts)}/sessions`;

  for (const p of resolveTranscriptPath(sessionId, cwd, opts)) {
    try { await access(p); return p; } catch { /* 试下一个 */ }
  }
  // 大小写不敏感 dirKey
  const { cwdToSessionDirKey } = await import("./transcript.mjs");
  const key = cwdToSessionDirKey(cwd);
  if (key) {
    try {
      const ents = await readdir(sessionsRoot, { withFileTypes: true });
      const hit = ents.find((e) => e.name.toLowerCase() === key.toLowerCase());
      if (hit) {
        const p = `${sessionsRoot}/${hit.name}/${sessionId}/session.v4.jsonl.zstd`;
        try { await access(p); return p; } catch { /* fallthrough */ }
      }
    } catch { /* ignore */ }
  }
  // 全局反查
  try {
    const { findTranscriptBySessionId } = await import("./transcript.mjs");
    return await findTranscriptBySessionId(sessionId, opts);
  } catch { return null; }
}

/** 直接从已知路径读+解压（跳过路径解析） */
async function readTranscriptFile(tpath) {
  const { decompressMultiFrameZstd, parseTranscriptText } = await import("./transcript.mjs");
  const { readFile } = await import("node:fs/promises");
  try {
    const raw = await readFile(tpath);
    return { records: parseTranscriptText(decompressMultiFrameZstd(raw)), path: tpath, error: null };
  } catch (e) {
    if (e?.code === "ENOENT") return { records: [], path: tpath, error: null };
    return { records: [], path: tpath, error: String(e?.message ?? e) };
  }
}

/** fs.stat 的 Promise 封装（避免新增顶层 import） */
async function fspStat(p) {
  const { stat } = await import("node:fs/promises");
  return stat(p);
}

// —— thread/unsubscribe：VS Code 释放某 chat 的订阅（本地无长驻订阅，幂等成功即可）
rpc.onRequest(CODEX_HOST_REQUEST.threadUnsubscribe, async () => ({}));

// —— thread/turns/list：列某 session 的轮次
//   ★ 2026-10-16：此前恒返回空列表。VS Code 只在 `historyMode === "paginated"` 时走这里，
//     桥保持 `legacy`（非 paginated）故正常不会走到；但为契约完整 + 兼容上游变更，
//     仍按官方 `ThreadTurnsListResponse`（{data, nextCursor, backwardsCursor}）回真实轮次。
rpc.onRequest(CODEX_HOST_REQUEST.threadTurnsList, async (params) => {
  const sid = params?.threadId ?? params?.sessionId;
  const rec = sid ? state.byThread.get(sid) : null;
  let data = [];
  if (sid) {
    try { data = await loadHistoryTurns(sid, rec?.cwd ?? params?.cwd ?? args.cwd); }
    catch { /* 退回空列表（上游走 includeTurns 全量路径） */ }
  }
  return { data, nextCursor: null, backwardsCursor: null };
});

// —— 模型切换：thread/settings/update → session/set_config_option
rpc.onRequest(CODEX_HOST_REQUEST.threadSettingsUpdate, async (params) => {
  const sid = params?.threadId ?? params?.sessionId;
  const model = params?.model ?? params?.settings?.model;
  LOG("info", `thread/settings/update: sid=${String(sid).slice(-12)} rawModel=${JSON.stringify(model)}`);
  if (sid && model) {
    // ★ 血案修复（2026-10-11）：VS Code 可能传来 BYOK 形态 `customendpoint/<vendor>/<model>`，
    //   旧实现只剥 `agent-host-dsh:` 前缀 ⇒ 原样透传给 DSH ⇒ unknown model option
    //   ⇒ 回落默认 provider(deepseek-official/api.deepseek.com) ⇒ 用 lobsterai 的 key ⇒ 401
    //   ⇒ UI 显示 `错误: (undefined) undefined`。
    //   修：用已缓存模型清单把任意形态的 id 解析回 DSH 的 ["provider","model"] value。
    const catalog = [
      ...(state.bootstrapModels ?? []),
      ...Array.from(state.byThread.values()).flatMap((r) => {
        try { return sessionNewToThreadStart({ sessionId: r.sessionId, configOptions: r.lastConfigOptions }, HOST_PREFIX).models ?? []; }
        catch { return []; }
      }),
    ];
    const resolved = translateModelSelectionToDsh(model, HOST_PREFIX, catalog);
    if (!resolved) {
      LOG("error", `thread/settings/update: 无法把模型 ${JSON.stringify(model)} 解析为 DSH model value；已拒绝设置（避免静默回落默认 provider）`);
      throw new Error(`unknown model: ${model}；该模型不在 DSH 可用模型清单内（拒绝设置以避免回落到默认 provider 导致鉴权失败）`);
    }
    LOG("info", `thread/settings/update: resolved model -> ${resolved.value} (${resolved.matchedBy})`);
    const res = await dsh.setConfigOption(sid, "model", resolved.value);
    // ★ 回读校验（2026-10-16）：以 DSH 回执为准，不匹配则明确告知（不再静默乐观）。
    let back2 = null;
    try { back2 = translateConfigOptionsToModels(res?.configOptions, HOST_PREFIX)?.currentModel ?? null; } catch { /* 忽略 */ }
    const applied2 = back2 !== null && JSON.stringify(back2) === JSON.stringify(resolved.value);
    LOG("info", `thread/settings/update: 落地校验 value=${resolved.value} DSH回读=${JSON.stringify(back2)} ${applied2 ? "✅通过" : "❌不通过(DSH 未采纳)"}`);
    const rec = state.byThread.get(sid);
    if (rec) rec.lastConfigOptions = res?.configOptions;
    return { configOptions: res?.configOptions };
  }
  return {};
});

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 三档权限（2026-10-15）
//
// 契约（逐字取自 @github/copilot-sdk 的 generated/rpc.d.ts + session-events.d.ts）：
//   permissions.setMode({mode})  → 期望 { success:boolean, mode:PermissionMode }
//        PermissionMode = "manual" | "assisted" | "allow-all"
//        调用方判据：`t.success && (t.mode===void 0 || t.mode===e)`
//   sandbox.disableForSession({requestId}) → 期望 { success:boolean, enabled:boolean }
//        调用方判据：`if(!c.success || c.enabled) throw "did not disable sandboxing"`
//   sandbox.getHostSupport() → { supported:boolean, reason?, capabilities:[{name,supported}] }
//
// ★ 桥的实现策略（2026-10-15 更新，方案 D 已实施）：
//   DSH 三档（read-only/workspace-write/danger-full-access）的**当场生效**写路径 =
//     直调扩展方法 `_bowei/sandbox-setMode({sessionId,mode})`（内部 session.append('sandbox/mode')）。
//   profile patch + HMR 是**部署默认档**通道，但受 session pin 机制所限，
//     **对已存在会话无效**（session 创建时档位已永久写进日志）。
//   ⇒ 双路策略：
//       ① **live 路**（首选）：对 `state.byThread` 中**全部**活会话逐个直调扩展方法 ——
//          当场生效、per-session、不碰磁盘。这是修好症状②的关键。
//       ② **patch 路**（回退）：对端无 `_bowei` 扩展（-32601，未装补丁/旧版 DSH）时，
//          退回写 profile patch（行为不退化，仍能被**新开会话**继承）。
//   ★ 为什么对「全部活会话」而不是「单个」：VS Code 侧 `permissions.setMode({mode})`
//     的 payload **不含 sessionId**（agentHostMain.js 逐字：`rpc.permissions.setMode({mode:e})`），
//     stdio JSON-RPC 也无 channel/scope 头 ⇒ 桥侧无法定位"是哪个会话在请求"。
//     一个桥进程 = 一个 VS Code 实例的全部会话，故按实例粒度应用到所有活会话是唯一自洽解。
//   ★ 另记 `state.permissionMode`，使**此后新建**的会话在 thread/start 时也套用该档
//     （否则新会话仍拿到 pinned 默认档 ⇒ 又回到症状②）。
// ══════════════════════════════════════════════════════════════════════════

/**
 * 内部：把 DSH 档应用到**全部活会话**（live 路）。
 * @returns {{attempted:number, applied:number, unsupported:boolean}}
 */
async function applyDshModeToLiveSessions(dshMode, why) {
  const sids = Array.from(state.byThread.keys());
  if (sids.length === 0) return { attempted: 0, applied: 0, unsupported: false };
  let applied = 0;
  for (const sid of sids) {
    const r = await dsh.sandboxSetMode(sid, dshMode);
    if (r === null) return { attempted: sids.length, applied, unsupported: true };
    if (r?.mode === dshMode) applied++;
  }
  LOG("info", `permission(live): ★ 已对 ${applied}/${sids.length} 个活会话直调 _bowei/sandbox-setMode = ${dshMode}（${why}）`);
  return { attempted: sids.length, applied, unsupported: false };
}

/** 内部：把 DSH 档写进 profile patch（幂等，回退路），并记录结果。返回是否写入成功。 */
async function applyDshModeToProfilePatch(dshMode, why) {
  try {
    const res = await applyPermissionModeToProfile(dshMode, {
      profile: args.profile ?? "acp",
      dshHome: args["dsh-home"],
      onBackup: (b) => LOG("info", `permission: 已备份 patch → ${b}`),
    });
    state.permissionSyncResult = { ...res, why, at: new Date().toISOString() };
    if (res.written) {
      LOG("info", `permission(patch): ★ 已把 DSH 档写为 ${dshMode}（${why}）→ ${res.patchPath}；HMR 将热加载（仅影响新会话）`);
    } else {
      LOG("info", `permission(patch): patch 未变（${res.reason}），档位记作 ${dshMode}（${why}）`);
    }
    return { ok: true, mode: dshMode, written: res.written, reason: res.reason };
  } catch (e) {
    LOG("error", `permission(patch): 写入 profile patch 失败：${e?.message ?? e}`);
    return { ok: false, reason: "write-failed", error: String(e?.message ?? e) };
  }
}

/**
 * 内部：把 DSH 档应用到当前会话（live）+ 记录部署默认（patch 兜底）。
 *
 * 顺序（★ 关键）：**先 live 再 patch**。
 *   - live 成功 ⇒ 当场生效（症状②修复），**不再写盘**（避免无意义磁盘写与 HMR）；
 *     但仍把档位记进 `state.permissionMode` 供新会话继承。
 *   - live 不支持（-32601）⇒ 回退 patch 写盘（行为退化到"仅新会话生效"，不报错）。
 */
async function applyDshPermissionMode(dshMode, why) {
  if (!DSH_SANDBOX_MODES.includes(dshMode)) {
    LOG("warn", `permission: 非法 DSH 档 ${JSON.stringify(dshMode)}；仅接受 ${DSH_SANDBOX_MODES.join("/")}`);
    return { ok: false, reason: "invalid-mode" };
  }

  // —— live 路（首选）：逐活会话直调扩展方法，当场生效 ——
  let live = { attempted: 0, applied: 0, unsupported: false };
  try {
    live = await applyDshModeToLiveSessions(dshMode, why);
  } catch (e) {
    LOG("warn", `permission(live): 直调失败（${e?.code ?? "?"} ${e?.message ?? e}）⇒ 回退 patch 路`);
    live = { attempted: 0, applied: 0, unsupported: true };
  }

  if (live.applied > 0 && !live.unsupported) {
    // 当场生效：记档即可，不写盘
    state.permissionMode = dshMode;
    state.permissionSyncResult = { via: "live", mode: dshMode, sessions: live.applied, why, at: new Date().toISOString() };
    return { ok: true, mode: dshMode, applied: true, via: "live", sessions: live.applied, reason: "live-applied" };
  }

  // —— patch 路（回退 / 无活会话时的部署默认）——
  if (state.permissionMode === dshMode && live.unsupported) {
    LOG("info", `permission: 档位已为 ${dshMode}（${why}）；跳过写盘`);
    return { ok: true, reason: "already-applied", mode: dshMode, via: "patch" };
  }
  const res = await applyDshModeToProfilePatch(dshMode, why);
  if (res.ok) state.permissionMode = dshMode;
  return { ...res, via: "patch", liveApplied: live.applied };
}

/**
 * `permissions/setMode` —— VS Code 权限档下发（SDK 三档：manual/assisted/allow-all）。
 *
 * ★ 关键：本方法**同时**可能带来 `codexSandboxMode` 线索（VS Code 有时把
 *   `codex.sandboxMode` 一起塞进来），故用 `resolveDshModeFromSignals` 统一收敛。
 */
rpc.onRequest("permissions/setMode", async (params) => {
  const pm = params?.mode;
  const codexMode = params?.codexSandboxMode ?? params?.sandboxMode ?? params?.settings?.["codex.sandboxMode"];
  LOG("info", `permissions/setMode: mode=${JSON.stringify(pm)} codexSandboxMode=${JSON.stringify(codexMode)}`);

  // ★★ 血案预防（探针 F 段实测发现的缺陷）：
  //   `resolveDshModeFromSignals` 会用 `current` 兜底，但 `current` 是**上一次状态**，
  //   不是"本次输入的解析结果"。若本次 mode 非法仍回落 current 并回 success:true，
  //   VS Code 会以为"设成了那个非法值" ⇒ **静默失真**（与 thread/revert 空成功同类）。
  //   ⇒ 严格要求**本次输入至少一个合法**（codex 直通 或 SDK 三档反查），才允许继续。
  const codexDirect = codexModeToDshMode(codexMode);
  const viaSdk = permissionModeToDshMode(pm);
  if (!codexDirect && !viaSdk) {
    LOG("warn", `permissions/setMode: 本次输入无法解析（mode=${JSON.stringify(pm)} codex=${JSON.stringify(codexMode)}）⇒ 回 success:false，保持现档 ${state.permissionMode ?? "-"}`);
    return { success: false, mode: pm, dshMode: state.permissionMode, reason: "unresolvable-mode" };
  }
  const dshMode = codexDirect ?? viaSdk;
  const r = await applyDshPermissionMode(dshMode, `setMode(${pm ?? "-"}${codexMode ? ` / codex:${codexMode}` : ""})`);
  // ★ 回执必须带 mode（调用方 `t.mode===void 0 || t.mode===e` 二选一通过；显式回更稳）
  // ★ via 字段（桥扩展，非契约）：live=当场生效；patch=回退写盘（仅新会话生效）
  return { success: r.ok, mode: r.mode ?? pm, dshMode, applied: r.ok, via: r.via, sessions: r.sessions, reason: r.reason };
});

/** `permissions/getMode`（部分版本会先读一次）—— 回读当前档 */
rpc.onRequest("permissions/getMode", async () => ({
  success: true,
  mode: dshModeToPermissionMode(state.permissionMode) ?? "manual",
  dshMode: state.permissionMode,
}));

/**
 * `sandbox/disableForSession` —— 「允许全部」按钮的沙箱旁路。
 *
 * 契约：期望 `{ success:true, enabled:false }`（`if(!c.success||c.enabled) throw`）。
 * ★ 语义：本次会话解沙箱 ⇒ 映射到 DSH 的 `danger-full-access`（唯一"不限制"档）。
 */
rpc.onRequest("sandbox/disableForSession", async (params) => {
  LOG("info", `sandbox/disableForSession: requestId=${JSON.stringify(params?.requestId)}`);
  const r = await applyDshPermissionMode("danger-full-access", "sandbox/disableForSession(allow-session)");
  return { success: r.ok, enabled: r.ok ? false : true, via: r.via };
});

/** `sandbox/getEnableState` / 状态回读 */
rpc.onRequest("sandbox/getEnableState", async () => ({
  enabled: state.permissionMode !== "danger-full-access",
  mode: state.permissionMode,
}));

/**
 * `sandbox/getHostSupport` —— 宿主能力探测。
 *
 * 契约：`{ supported:boolean, reason?, capabilities:[{name,supported}] }`
 * 调用方在 !supported 时用 reason 提示；否则按 capabilities 过滤告警。
 * ★ 桥**声明 supported:true** —— 因为桥确实能通过 profile patch 切换 DSH 三档
 *   （能力真实存在），而不是"假装支持"。
 */
rpc.onRequest("sandbox/getHostSupport", async () => ({
  supported: true,
  capabilities: [
    { name: "shell", supported: true },
    { name: "filesystem_enumeration", supported: true },
    { name: "denied_paths", supported: false },
    { name: "network", supported: false },
    { name: "network_filtering", supported: false },
  ],
  /** 桥扩展字段（非契约，诊断用）：当前 DSH 档 */
  dshMode: state.permissionMode,
}));

/**
 * `_bowei/permission-status`（桥私有扩展，非 VS Code 契约）—— 诊断用。
 *
 * 回报当前档位、同步路径（live/patch）、活会话数与最近一次同步结果。
 * 供 e2e 探针与人工排障读取「档位到底有没有当场落到执行层」。
 */
rpc.onRequest("_bowei/permission-status", async () => ({
  permissionMode: state.permissionMode,
  syncResult: state.permissionSyncResult ?? null,
  lastApprovalsReviewer: state.lastApprovalsReviewer,
  lastInteractionMode: state.lastInteractionMode,
  liveSessions: Array.from(state.byThread.keys()),
  liveSessionCount: state.byThread.size,
}));


rpc.onRequest(CODEX_HOST_REQUEST.turnStart, async (params) => {
  const p = turnStartToPrompt(params);
  // ★★★ P7 探针（2026-10-16，三轴血案）：把 turn/start **原始参数的键名与三轴值**
  //   一次性打全 —— 这是判定「UI 选的审核/交互/权限到底有没有传到桥」的唯一第一现场。
  //   血案：此前桥只取 sessionId/prompt，三轴字段名从不出现在任何日志里
  //   ⇒ 无法区分「VS Code 没传」与「传了但桥丢」⇒ 只能靠读官方源码反推。
  //   现在恒打：`keys` 让"有没有这个字段"一目了然。
  try {
    LOG("info", `[probe-axes] T=${probeT()} P7 turn/start keys=${JSON.stringify(Object.keys(params ?? {}))}` +
      ` approvalPolicy=${JSON.stringify(params?.approvalPolicy ?? null)}` +
      ` permissions=${JSON.stringify(params?.permissions ?? null)}` +
      ` approvalsReviewer=${JSON.stringify(params?.approvalsReviewer ?? null)}` +
      ` collaborationMode=${JSON.stringify(params?.collaborationMode ?? null)}` +
      ` sandboxMode=${JSON.stringify(params?.sandboxMode ?? params?.sandbox ?? null)}`);
  } catch { /* 观测代码绝不影响主流程 */ }
  const sid = p.sessionId;
  // ★ 自愈闸门 ②：turn 是超时现象的直接所在。通道死了就地重建；
  //   若该 session 在新进程里不存在，给出**明确即时错误**（而不是让上游等 120s）。
  try {
    await ensureDshAlive();
  } catch (e) {
    throw new Error(`turn/start: dsh channel unavailable: ${e?.message ?? e}`);
  }
  if (!state.byThread.has(sid)) {
    // 新旧进程间的 session 不能跨进程复用
    throw new Error(`turn/start: unknown thread ${sid}; call thread/start (or thread/resume) first`);
  }

  // ★★ T2（turnId 贯通，2026-10-11）：**轮次单一真源在桥侧**。
  //   血案：旧版返回伪造的 `turn-${Date.now()}` 且从不发 turn/started、通知不带 turnId
  //   ⇒ renderer 的 activeTurn.id 与通知的 turnId 永不对齐 ⇒ 所有 item 静默丢弃。
  //   修：① 生成真 turnId；② 先发 turn/started（带 turn.id）；
  //       ③ 登记到 byThread.currentTurnId，供 session/update 与收尾复用。
  //
  // ★★★ 血案升级（2026-10-16，对话永久空白 / notDispatched）——**真源必须让位给 VS Code**：
  //   renderer 在派发一轮时自己生成 requestId 并登记 _clientDispatchedTurnIds：
  //     (sessions.desktop.main.js @21322806) this._clientDispatchedTurnIds.add(c)  // c = requestId
  //   收到 chat/turnStarted 后：
  //     if (this._clientDispatchedTurnIds.has(O.id)) {...return}       // 认得 ⇒ 正常
  //     else "Server-initiated turn detected" ⇒ V.startServerRequest(O.id, O.message.text, ...)
  //   上一版桥自造 "turn-<ts>" ⇒ renderer 认不出 ⇒ 走 server 分支
  //   ⇒ ① 多插一条消息（双条）② O.message 被删又导致 TypeError（读 undefined.text）
  //   ⇒ 帧链中断 ⇒ _acceptInput falsy ⇒ notDispatched ⇒ 气泡永久空白。
  //   ★ 修法：**优先使用注入层透传的 vscodeTurnId**（= renderer 的 requestId），
  //     仅在其缺失时回退自造（保证不空转）。
  const userText = (p.prompt ?? []).map((x) => x?.text ?? "").join("");
  const turnId = (p.vscodeTurnId && String(p.vscodeTurnId))
    || `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // ★★★ 2026-10-16 血案修复：「审核方式 / 交互方式 / 权限」三轴随 turn/start 下发。
  //   官方 `codexAgent.ts::_turnStartOptions()` 把 approvalPolicy / permissions /
  //   approvalsReviewer / collaborationMode 塞在 turn/start 参数里（**不走
  //   permissions/setMode**，实测该 RPC 调用数=0）⇒ 旧版桥全丢 ⇒ 三轴停在 DSH 默认档。
  //   修：解析 → 若有沙箱/审批信号，就地把档位应用到该会话（live 路，当场生效）。
  try {
    const axes = resolveTurnPermissionAxes(p.permissionAxes ?? {});
    if (axes.sandboxMode || axes.approval || axes.reviewer || axes.interactionMode) {
      LOG("info", `turn/start: 三轴解析 source=${axes.source} sandbox=${axes.sandboxMode ?? "-"} approval=${axes.approval ?? "-"} reviewer=${axes.reviewer ?? "-"} interaction=${axes.interactionMode ?? "-"}`);
    }
    if (axes.sandboxMode) {
      // 仅当与当前档不同才调用（幂等；避免无谓 RPC）
      if (state.permissionMode !== axes.sandboxMode) {
        // live 路：直接对该会话应用（DSH `_bowei/sandbox-setMode` 当场生效）
        const r = await dsh.sandboxSetMode(sid, axes.sandboxMode);
        if (r?.mode === axes.sandboxMode) {
          state.permissionMode = axes.sandboxMode;
          LOG("info", `turn/start: ★ 三轴已就地生效 sandbox=${axes.sandboxMode} (via live)`);
        } else if (r === null) {
          // 对端无 _bowei 扩展 ⇒ 回退 patch 路（仅新会话生效）
          LOG("warn", `turn/start: 三轴 live 路不可用（无 _bowei 扩展）⇒ 回退 patch 路`);
          await applyDshPermissionMode(axes.sandboxMode, `turn/start(axis:${axes.source})`);
        }
      }
    }
    // 记录 reviewer / interactionMode 供诊断（DSH 侧无对应概念，不虚构映射）
    if (axes.reviewer) state.lastApprovalsReviewer = axes.reviewer;
    if (axes.interactionMode) state.lastInteractionMode = axes.interactionMode;
  } catch (e) {
    // 三轴失败**绝不阻断主流程**（宁可权限不变，也不能让消息发不出去）
    LOG("warn", `turn/start: 三轴应用失败（已忽略，不影响本轮发送）：${e?.message ?? e}`);
  }
  const rec = state.byThread.get(sid);
  rec.currentTurnId = turnId;
  /**
   * ★★★ 血案修复（2026-10-16）：**每轮重置 agentMessage item 去重集**。
   *   与 `onSessionUpdate` 里的 `ctx.seenAgentItems` 配对使用：
   *   新一轮若复用同一 messageId（DSH 侧 id 可能跨轮稳定），必须重新发
   *   `item/started` 才能在 renderer 里重建 `itemToPartId` 映射，
   *   否则该轮的 deltas 全部被 `mapAgentMessageDelta` 静默丢弃。
   */
  rec.seenAgentItems = new Set();
  /**
   * ★★★ 2026-10-17：同款重置 **reasoning（思考）item 去重集**。
   *   与 `onSessionUpdate` 的 `ctx.seenReasoningItems` 配对。思考块无 DSH 稳定 id，
   *   以 `think-<turnId>` 为身份 ⇒ 换轮必须重置，否则新一轮的思考 item 被误判为
   *   "已发过" ⇒ 只发 delta 不发 started ⇒ renderer 无 itemToPartId 映射 ⇒ 静默丢弃。
   */
  rec.seenReasoningItems = new Set();
  const startedAt = new Date().toISOString();

  // ── FLOW：turn 开始 ──────────────────────────────────────────────
  const fid = `${sid.slice(-8)}:${turnId}`;
  flowIn("turn", fid, `thread=${sid.slice(-8)} turn=${turnId} text="${userText.slice(0, 40)}"`);
  flowMark("turn/started → VS Code", `turn=${turnId}`);
  const started = translateTurnStarted(sid, turnId, userText, startedAt);
  assertTurnShape(started.method, started.params);          // ★ 契约自检（防静默失败）
  rpc.notify(started.method, started.params);
  flowOut("turn/started", fid);

  // prompt 是长请求：DSH 会在完成前持续推 session/update
  const t0 = Date.now();
  flowMark("prompt → DSH acp", `session=${sid.slice(-8)} (长请求，等 DSH 完成)`);
  dsh.prompt(sid, p.prompt)
    .then(() => {
      if (rec.currentTurnId === turnId) rec.currentTurnId = null;  // 清空，避免泄漏到下一轮
      const dur = Date.now() - t0;
      flowOut("prompt ← DSH acp", fid, `耗时${dur}ms`);
      /**
       * ★★★ 补齐 agentMessage 的 item 生命周期（2026-10-16，血案修复收尾）。
       *
       *   官方 `mapItemCompleted`（codexMapAppServerEvents.ts）对 `agentMessage`：
       *     ```js
       *     if (params.item.type === 'agentMessage') {
       *       state.itemToPartId.delete(params.item.id);   // 释放映射
       *       return [];                                    // 不再产生 action
       *     }
       *     ```
       *   —— renderer **不靠 `item/completed` 渲染文本**（文本已由 started/delta 落地），
       *   它只清理映射。**但缺了它映射会一直滞留**，且官方注释明确把 completed
       *   当作"delta 丢失时的兜底（带全量 text）"。
       *   桥侧因无 itemId→text 的权威累计值，这里**只做映射清理**（保守、不会重复渲染）。
       */
      const seen = rec.seenAgentItems;
      if (seen && seen.size) {
        /**
         * ★ 契约（官方 proto）：`ItemCompletedNotification = { item, threadId, turnId, completedAtMs }`；
         *   AgentMessage item 的 required = {type,id,text}（其余可空）⇒ 一并给全。
         */
        for (const itemId of seen) {
          rpc.notify(CODEX_NOTIFICATION.itemCompleted, {
            threadId: sid, turnId,
            item: { id: itemId, type: "agentMessage", text: "",
                    phase: null, memoryCitation: null, delivery: null, questions: null },
            completedAtMs: Date.now(),
          });
        }
        seen.clear();
      }
      /**
       * ★★★ 2026-10-17：**同款收尾 reasoning（思考）item**。
       *   reasoning 的 ThreadItem required 只有 `{id, type}`（schema 实证）⇒
       *   completed 只需 `{id, type:"reasoning"}`；与 agentMessage 一样，
       *   renderer 靠它**释放 `itemToPartId` 映射**（否则映射滞留，下一轮同 id 误判）。
       *   ★ 不塞 content 是**刻意的保守**：桥侧无权威累计文本 ⇒ 给了反而可能重复渲染。
       */
      const seenRz = rec.seenReasoningItems;
      if (seenRz && seenRz.size) {
        for (const itemId of seenRz) {
          rpc.notify(CODEX_NOTIFICATION.itemCompleted, {
            threadId: sid, turnId,
            item: { id: itemId, type: "reasoning" },
            completedAtMs: Date.now(),
          });
        }
        seenRz.clear();
      }
      const done = translatePromptDone(sid, turnId, dur);
      flowMark("turn/completed → VS Code", `turn=${turnId}`);
      assertTurnShape(done.method, done.params);            // ★ 契约自检
      rpc.notify(done.method, done.params);
      flowOut("turn", fid, "正常完成");
    })
    .catch((e) => {
      flowErr("prompt ← DSH acp", e, `session=${sid.slice(-8)}`);
      if (rec.currentTurnId === turnId) rec.currentTurnId = null;
      const failed = translatePromptDone(sid, turnId, Date.now() - t0);
      // ★ 失败也走 turn/completed（带 turn 包装），status 标 failed ⇒ 触发 ChatError 渲染
      //   （官方 `mapTurnCompleted`：`status==='failed' && turn.error` → ActionType.ChatError）
      const userMsg = userFacingErrorText(e, "turn");
      failed.params.turn.status = "failed";
      failed.params.turn.error = { message: userMsg };  // 官方 TurnError.required=["message"]
      failed.params.error = { message: userMsg };       // 保留扁平字段（注入层读它）
      // ★★ 严格自检：失败通知是本轮"异常必须送达用户"的**唯一载体**，
      //    宁可不发也不发畸形包（畸形包会在上游静默崩，等于没上报）。
      assertTurnShape(failed.method, failed.params, ["threadId", "turn"], true);
      rpc.notify(failed.method, failed.params);
      /**
       * ★ 2026-10-17：失败路径**同样要清理两组 item 映射**（agentMessage + reasoning）。
       *   否则这些 id 会滞留在 rec 上，下一轮若复用同 id ⇒ 误判"已发过 started"
       *   ⇒ delta 被静默丢弃（同族血案）。清空是幂等的，成本为零。
       */
      try { rec.seenAgentItems?.clear(); rec.seenReasoningItems?.clear(); } catch { /* 忽略 */ }
      flowOut("turn", fid, `失败结束(kind=${classifyError(e).kind}): ${String(e?.message ?? e).slice(0, 80)}`);
    });
  // ★★★ 契约统一（2026-10-16）：权威 `TurnStartResponse` required = `["turn"]`，
  //   且 `Turn` required = `["id","items","status"]`（schema/v2/TurnStartResponse.json）。
  //   此前桥只回 `{threadId, turnId}` ⇒ 上游读 `res.turn.id` 即 `undefined.id` 崩溃。
  //   ★ 时间单位：`Turn.startedAt` 权威描述是 **Unix 秒**（不是毫秒！别照搬 Date.now()）。
  //   ★ 同时保留扁平 `turnId`/`threadId`（桥内部与历史注入层可能引用，零成本向后兼容）。
  return {
    turn: {
      id: turnId,
      items: [],
      status: "inProgress",                 // TurnStatus ∈ completed|interrupted|failed|inProgress
      startedAt: Math.floor(Date.parse(startedAt) / 1000) || Math.floor(Date.now() / 1000),
    },
    threadId: sid,
    turnId,
  };
});

// —— 中断：turn/interrupt → session/cancel
rpc.onRequest(CODEX_HOST_REQUEST.turnInterrupt, async (params) => {
  const sid = params?.threadId ?? params?.sessionId;
  if (sid) dsh.cancel(sid);
  return {};
});

// ---------------------------------------------------------------- detached worktree（VS Code vscode/* 系列）
/**
 * ★ 契约（全部 bundle 实证，见 src/worktree.mjs 顶部注释）：
 *   VS Code 在 `sessionConfig.values.isolation === "worktree"` 时，要求 agent host：
 *     ① initialize 结果带 `_meta["vscode.detachedWorktrees"] === true`
 *     ② 实现 create / claim / delete 三个方法（缺一即抛 NLS[6194]）
 *     ③ 另有 reconcile / setArchived 两个方法用于生命周期维护
 *   create 返回 `{ handle, resource }`，resource 是 URI 字符串（本机 file://）；
 *   其余四个方法只回 `{}`（VS Code 侧不消费返回值，但**必须成功 resolve**，否则抛错）。
 *
 * 关闭开关 `--worktree false` 时不注册 ⇒ 走 "*" 兜底回 -32601 ⇒ VS Code 明确报"不支持"。
 */
if (WORKTREE_SUPPORT) {
  rpc.onRequest(WORKTREE_METHOD.create, async (params) => {
    LOG("info", `worktree/create: session=${String(params?.session ?? "").slice(0, 60)}`);
    const res = await worktrees.create({
      session: params?.session,
      prompt: params?.prompt,
      workingDirectory: params?.workingDirectory ?? args.cwd ?? process.cwd(),
      config: params?.config,
    });
    LOG("info", `worktree/create: handle=${res.handle} resource=${res.resource}`);
    return res;
  });

  rpc.onRequest(WORKTREE_METHOD.claim, async (params) => {
    LOG("info", `worktree/claim: handle=${params?.handle}`);
    return worktrees.claim(params ?? {});
  });

  rpc.onRequest(WORKTREE_METHOD.delete, async (params) => {
    LOG("info", `worktree/delete: handle=${params?.handle}`);
    return worktrees.delete(params ?? {});
  });

  rpc.onRequest(WORKTREE_METHOD.reconcile, async (params) => {
    LOG("info", `worktree/reconcile: scope=${String(params?.scope ?? "").slice(0, 60)} active=${params?.activeHandles?.length ?? 0}`);
    return worktrees.reconcile(params ?? {});
  });

  rpc.onRequest(WORKTREE_METHOD.setArchived, async (params) => {
    LOG("info", `worktree/setArchived: handle=${params?.handle} archived=${params?.archived}`);
    return worktrees.setArchived(params ?? {});
  });
}

// —— 兜底：未实现的方法**按方法族返回语义化空值**，而不是一律 MethodNotFound。
//    ★★★ 教训（2026-10-11）：VS Code 对 MethodNotFound 会**当成致命错误**抛给 UI
//    （实证：`thread/read` 缺实现 ⇒ `Session was never created on the backend` 刷屏）。
//    而"合法空响应"能让上游优雅降级（会话/账号/配置"暂不可用"但流程不断）。
//    真正的未知方法（不在任何已知族里）才回 MethodNotFound。
const IMPL_FALLBACK = [
  // ★★★ V2 补丁 M5（2026-10-16）：兜底表里 3 处返回形状不符官方契约，逐项修正。
  //   【M5a】account/read：官方 `GetAccountResponse = { account: Account|null, requiresOpenaiAuth: boolean, workspaceRouting: WorkspaceRouting|null }`。
  //     原回 `{ account: null }` ⇒ `requiresOpenaiAuth`/`workspaceRouting` 缺失。
  //     VS Code L3338 读 `response.requiresOpenaiAuth` ⇒ 日志显示 undefined（V1 垫片实测即如此）。
  //     修：补全三字段。桥无账号 ⇒ account=null（合法），requiresOpenaiAuth=false（桥不驱动 VS Code 登录）。
  [/^account\/read$/,            () => ({ account: null, requiresOpenaiAuth: false, workspaceRouting: null })],
  // 注意：rateLimits 必须排在 `^account\/` 通配**之前**（下面还有一条 ^account\/ 兜其它 account 子方法）
  [/^account\/rateLimits\//,     () => ({})],
  [/^getAuthStatus$/,            () => ({ authenticated: false })],
  //   【M5b】config/read：官方 `ConfigReadResponse = { config: Config, origins: {...}, layers: ConfigLayer[]|null }`。
  //     原回 `{}` ⇒ VS Code L2293 `configResponse.config.model_provider` **读 undefined.config ⇒ TypeError 风险**
  //     （虽有 `?? CODEX_OPENAI_MODEL_PROVIDER` 兜底，但 `{}` 连 `.config` 都没有，取属性即 undefined → 不抛，
  //      但语义上空；仍按契约补全更稳）。修：给最小合法 Config。
  //
  //   ★★★ V2 补丁 M6（2026-10-16）：**model_provider 由 "vscode-proxy" 改为 "openai"** —— 治
  //     `(modelSelectionFailed) Authentication is required to use Codex` 的**直接且唯一**根因。
  //     证据链（全部来自 agentHostMain.js 实测反编译）：
  //       ① `_refreshModels`：`let s = o.config.model_provider ?? ls`（`ls = "openai"`，官方兜底值），
  //          然后 `id: Iu(s, g.model)` ⇒ 模型 id = `@provider=<s>:<model>`。
  //       ② `jr(id)`：解析 `@provider=` 前缀得 `modelProvider`；**无前缀才兜底 `aB = "vscode-proxy"`**。
  //       ③ `_ensureModelProviderAuthenticated(e)`：
  //            `if ((e ? jr(e).modelProvider : yA) !== yA) return;`   // `yA = "vscode-proxy"`
  //            `if (!this._githubToken) throw Error("Authentication is required to use Codex")`
  //          ⇒ 当 `s = "vscode-proxy"` 时，模型 `modelProvider === yA` ⇒ **进入校验** ⇒ 本机无
  //            GitHub 令牌（`_githubToken` 空）⇒ 抛错。
  //     改 `"openai"` 后：`jr(id).modelProvider = "openai" !== yA` ⇒ **第一步即 return，完全不触发鉴权**。
  //     附带收益：`_meta.modelGroupId = Gw(s)` ⇒ 模型选择器分组标题由误导性的 `Vscode-proxy`
  //       变为 `openai`（= 官方 Codex 的原生 provider 名），符合"完全假冒 codex"的目标。
  //     安全性：`openai` 是官方代码里的默认值（`ls`），桥不驱动 VS Code 登录（`account: null`），
  //       因此 `requiresOpenaiAuth` 分支不会被走到；模型 id 仍是 `@provider=openai:<model>`，
  //       `jr()` 解码后 `modelId` 仍为裸模型名 ⇒ 桥侧 `thread/start`/`turn/start` 反解**零改动**。
  [/^config\/read$/,             () => ({
    config: {
      model: null,
      review_model: null,
      model_context_window: null,
      model_auto_compact_token_limit: null,
      model_auto_compact_token_limit_scope: null,
      // ★ M6：必须为 "openai"（官方兜底值），否则触发 Codex 的 GitHub 令牌鉴权 ⇒ 报 modelSelectionFailed
      model_provider: "openai",
      approval_policy: null,
      approvals_reviewer: null,
      sandbox_mode: null,
      sandbox_workspace_write: null,
      forced_chatgpt_workspace_id: null,
      forced_login_method: null,
      web_search: null,
      tools: null,
      instructions: null,
      developer_instructions: null,
      compact_prompt: null,
      model_reasoning_effort: null,
      model_reasoning_summary: null,
      model_verbosity: null,
      service_tier: null,
      analytics: null,
      apps: null,
      browser_use: null,
      computer_use: null,
      desktop: null,
    },
    origins: {},
    layers: null,
  })],
  //   【M5c】hooks/list：官方 `HooksListResponse = { data: HooksListEntry[] }`。
  //     原回 `{ hooks: [] }` ⇒ VS Code `_fetchSkillHookContainers` 里 `hooks.data.map(...)`
  //     读 undefined.map ⇒ TypeError（被 .catch 兜成 warn，但钩子面板永远空）。
  //     修：键名 `hooks` → `data`，且 `data` 恒存在。
  [/^hooks\/list$/,              () => ({ data: [] })],
  // 其余 hooks/* 子方法（若有）保持原样
  [/^hooks\//,                   () => ({})],
  [/^mcpServer\//,               () => ({})],
  [/^thread\/turns\//,           () => ({ turns: [], nextCursor: null })],
  // ★★ 2026-10-15 修正：**`thread/revert` 从本表摘除**（原与 fork/archive 同组，回空成功 `{}`）。
  //   血案：宿主点「还原检查点」走 `thread/revert`，桥回空成功 ⇒ **UI 显示"已还原"但实际什么都没回滚**
  //   （文件没回退、DSH 历史没截断）⇒ **静默失真，比报错更危险**。
  //   修：让它落到本表末尾 ⇒ 回 MethodNotFound ⇒ UI 显式报错（用户知道该功能不可用）。
  //   ★ 保留 fork/archive/unarchive/compact/start 的空成功 —— 它们是"合法空响应"，
  //     上游能优雅降级（fork 失败可退化为新会话），不会造成"假装做成了"的错觉。
  [/^thread\/(fork|archive|unarchive|compact\/start|approveGuardianDeniedAction)$/, () => ({})],
  [/^turn\/steer$/,              () => ({})],   // 桥为单轮直通，不支持中途 steer；幂等空成功
];
rpc.onRequest("*", async (_p, id, method) => {
  const m = String(method ?? "");
  for (const [re, make] of IMPL_FALLBACK) {
    if (re.test(m)) {
      LOG("info", `fallback(empty) for unimplemented method: ${m}`);
      return make();
    }
  }
  // ★ 特殊提示：revert 是有意摘除的，日志点明原因，避免下次误以为"漏了"
  if (/^thread\/revert$/.test(m)) {
    LOG("warn", `thread/revert: 桥未实现历史截断（DSH ACP 无对应方法）⇒ 显式回 MethodNotFound，避免静默假还原`);
  }
  LOG("warn", `method not found (no handler, no fallback): ${m}`);
  return { __error: { code: JsonRpcErrorCode.MethodNotFound, message: `Bridge: method not implemented: ${m}` } };
});

// ---------------------------------------------------------------- 异常上报
/**
 * ★★★ 把「DSH 后端已死」这件事实**送达用户界面**（2026-10-16 新增）。
 *
 * 【它解决什么】"整套机制的异常无法反馈给使用者"的核心场景之一：
 *   后端进程挂了，UI 却在原地转圈 —— 用户不知道发生了什么，也不知道能做什么。
 *
 * 【送达方式 —— 依据 VS Code 官方源码实测选定】
 *   ★ 反例（不要用）：`thread/status/changed` 出现在 VS Code
 *     `_registerIgnoredNotifications()` 的**忽略列表**里（codexAgent.ts:3272-3281），
 *     发了等于没发；`error` 通知也只被 `_registerWorkingDirectoryNotifications`
 *     用于「工作目录切换失败」这一条窄路径，不是通用错误通道。
 *   ★ 正解：让它**落在对话里** —— 这才是用户一定看得见的地方：
 *     ① 有在跑的轮次 ⇒ 立刻补发 `turn/completed`（status=failed + 可读 hint），
 *        结束"正在分析"，把错误作为本轮结果呈现；
 *     ② 同时发一条 `item/completed`（error 类型 item），使对话中出现**明确的错误条目**，
 *        即使该轮次已结束/不存在也能看到原因。
 *
 * ★ 全部走 `assertTurnShape` / 显式字段校验：最坏是"被忽略"，不会引发新崩溃。
 */
/**
 * ★★★ 把「DSH 后端已死」这件事实**送达用户界面**（2026-10-16 新增，同日二次修正）。
 *
 * 【它解决什么】"整套机制的异常无法反馈给使用者"的核心场景之一：
 *   后端进程挂了，UI 却在原地转圈 —— 用户不知道发生了什么，也不知道能做什么。
 *
 * 【送达通道：唯一正确的一条】`turn/completed` + `status:"failed"` + `turn.error`
 *
 *   官方 VS Code 源码 `codexMapAppServerEvents.ts` `mapTurnCompleted()` 明文分支：
 *     `if (status === 'failed' && params.turn.error) → ActionType.ChatError`
 *        `part: createErrorResponsePart(mapCodexTurnError(params.turn.error))`
 *   即：**只有**这条组合会在对话里渲染出 `错误: (CodexError) <message>`。
 *
 * ★ 为什么不用另外两条通道（均为源码实证后放弃，勿再尝试）：
 *   ① `item/completed` 带自造 `type:"error"` —— 官方 `ThreadItem` 是 **19 种类型的
 *      联合体白名单**（userMessage/agentMessage/commandExecution/…），**没有 `error`**。
 *      发协议外类型 ⇒ 被丢弃（用户依然看不到），无收益且不规范。
 *   ② `error` 通知 —— VS Code 侧 `codexAgent.ts:3296` 的 handler **只**把它喂给
 *      `_workingDirectoryChangeForThread(threadId)`（切换工作目录的变更 Promise）；
 *      普通发消息场景该函数返回 `undefined` ⇒ 错误被**完全丢弃**。**它不是通用错误通道。**
 *   ③ `thread/status/changed` —— 该通知在 VS Code 侧被**显式忽略**。
 *
 * 【无活跃 turn 时怎么办】此时没有任何 `turn` 可收尾 ⇒ 无法通过上通道送达。
 *   不做无效广播，只在桥日志留下明确记录；用户下次发消息会**立即**从 `turn/start`
 *   请求路径拿到分类后的错误（见 rpc.mjs 统一错误分类）。
 *
 * @param message  人类可读的根因（如 "DSH 后端已停止（exit code=1）"）
 * @param threadIds 需要通知的活跃 thread 集合
 */
function onDshDeath(message, threadIds = []) {
  const be = classifyError(new Error(message), { stage: "dsh-child-exit" });
  const userMsg = userFacingErrorText(message, "dsh-child-exit");
  let reported = 0;

  for (const tid of threadIds) {
    const rec = state.byThread.get(tid);
    const turnId = rec?.currentTurnId;
    if (!turnId) continue;   // 没有在跑的轮次 ⇒ 这条通道不适用（见上方说明）

    try {
      const failed = translatePromptDone(tid, turnId, 0);
      // `turn.error` 是官方 `TurnError`（required = ["message"]）⇒ 触发 ChatError 渲染
      failed.params.turn.status = "failed";
      failed.params.turn.error = { message: userMsg };
      // ★ 关键：契约自检必须在**发送前**、且用**严格模式**跑。
      //   若这里抛错说明形状不合规，宁可只打日志也不能把畸形通知发出去
      //   （那会让上游再次静默崩，把"最后一道上报通道"也变成新的故障源）。
      assertTurnShape(failed.method, failed.params, ["threadId", "turn"], true);
      rpc.notify(failed.method, failed.params);
      rec.currentTurnId = null;
      reported++;
      LOG("info", `[flow] · turn/completed(failed)+error → VS Code turn=${turnId}（后端已死，主动收尾并送达错误）`);
    } catch (e) {
      LOG("warn", `[flow] ! 发送 turn/completed(failed) 失败：${e?.message ?? e}`);
    }
  }

  if (reported === 0) {
    LOG("warn", `[flow] ! DSH 已死但无在跑的轮次 ⇒ 无 turn 可收尾；` +
      `用户下次发消息将在 turn/start 处立即收到分类错误（kind=${be.kind}）`);
  }
}

// ---------------------------------------------------------------- 生命周期
// ★★★ P0-2 根治（2026-10-11）：host 关闭时**必须等 DSH 优雅退出（刷盘）后再 process.exit**，
//   否则 DSH 来不及持久化会话 ⇒ catalog 留孤儿 ⇒ 下次启动 subscribe 404 刷屏。
rpc.onClose(() => {
  LOG("info", "host closed, gracefully disposing dsh (wait for flush)…");
  Promise.resolve(dsh.dispose())
    .catch((e) => LOG("warn", "dsh.dispose error: " + (e?.message ?? e)))
    .finally(() => {
      LOG("info", "dsh disposed; exiting bridge");
      process.exit(0);
    });
  // 兜底：无论如何 6s 内退出，避免 host 已走而桥挂死
  const hardExit = setTimeout(() => { LOG("warn", "bridge force-exit after grace timeout"); process.exit(0); }, 6000);
  if (hardExit.unref) hardExit.unref();
});

// ★★★ P0-2 根治（2026-10-11）：进程收到退出信号（host 主动 kill 前的礼貌信号）时，
//   同样先优雅关停 DSH（关 stdin → 等刷盘），再退出。避免硬杀导致会话不落盘。
let _gracefulExiting = false;
const _gracefulExit = (sig) => {
  if (_gracefulExiting) return;
  _gracefulExiting = true;
  LOG("info", `received ${sig}; gracefully disposing dsh (wait for flush)…`);
  Promise.resolve(dsh.dispose())
    .catch((e) => LOG("warn", "dsh.dispose error: " + (e?.message ?? e)))
    .finally(() => { LOG("info", "dsh disposed; exiting"); process.exit(0); });
  const hardExit = setTimeout(() => { LOG("warn", "bridge force-exit after grace timeout"); process.exit(0); }, 6000);
  if (hardExit.unref) hardExit.unref();
};
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  try { process.on(sig, () => _gracefulExit(sig)); } catch { /* ignore */ }
}

LOG("info", `bridge up. providerId=${HOST_PROVIDER_ID} prefix=${HOST_PREFIX} dsh=${args["dsh-bin"]}`);

// ---------------------------------------------------------------- 顶层兜底（最后一道防线）
/**
 * ★★★ 进程级兜底（2026-10-16 新增）—— 此前**完全缺失**。
 *
 * 【为什么必须有】整个桥是"假冒 codex app-server"的长驻进程。任何一处
 *   **未捕获** 的异常（异步 handler 之外的代码、定时器回调、事件回调）都会：
 *     - Node 默认行为：打印堆栈后**直接进程退出** ⇒ VS Code 只看到"连接断了"，
 *       界面上的表现就是"发消息没反应 / 正在分析卡死"，**没有任何错误提示**；
 *     - 这正是"异常无法反馈给使用者"最严重的一种形态：**连桥自己都没机会说话**。
 *
 * 【做法】捕获后不静默、不立即自杀：
 *   ① 记录完整堆栈（`[flow] ! UNCAUGHT`，便于 grep 定位）；
 *   ② 尽力把错误推给 VS Code（有活跃 thread 就标异常 + 收尾在跑轮次）；
 *   ③ **不主动退出** —— 让 stdio 通道继续存活，用户下一次操作能拿到明确错误，
 *      而不是面对一个"莫名消失"的后端。（若真到了不可救药，VS Code 会自己重启桥。）
 *
 * ★ 为什么"不退"比"退"好：进程退出是**最不可诊断**的失败模式。
 *   保留进程 ⇒ 错误可送达、可 grep、可复现；退出 ⇒ 只有一句"连接已断开"。
 */
process.on("uncaughtException", (e) => {
  const be = classifyError(e, { stage: "uncaughtException" });
  LOG("error", `[flow] ! UNCAUGHT ${be.kind} :: ${e?.stack ?? e?.message ?? e}`);
  LOG("error", `[flow] ! UNCAUGHT 原始堆栈:\n${e?.stack ?? "(no stack)"}`);
  try { onDshDeath(`桥内部未捕获异常：${e?.message ?? e}`, Array.from(state.byThread.keys())); } catch { /* ignore */ }
});

process.on("unhandledRejection", (reason) => {
  const be = classifyError(reason, { stage: "unhandledRejection" });
  LOG("error", `[flow] ! UNHANDLED-REJECTION ${be.kind} :: ${reason?.stack ?? reason?.message ?? reason}`);
  try { onDshDeath(`桥内部未处理的 Promise 拒绝：${reason?.message ?? reason}`, Array.from(state.byThread.keys())); } catch { /* ignore */ }
});

// ★ 退出前留痕：任何原因导致的进程结束都记一条，便于区分"被 kill"与"自己崩"。
process.on("exit", (code) => {
  try { process.stderr.write(`[bridge] info: process exiting (code=${code}) uptime=${Math.round(process.uptime())}s\n`); } catch { /* ignore */ }
});
