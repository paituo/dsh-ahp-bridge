/**
 * ★★★ 统一错误分类与「用户可读化」（2026-10-16 新增）
 *
 * ─── 为什么需要这个模块 ────────────────────────────────────────────────
 * 症状：「整条链路出错时，用户界面上看到的不是原因，而是空白 / 永久转圈 /
 *       一句与真实原因无关的英文」——错误在中途被吞、被降级、被改写成
 *       InternalError，最终无法反馈给使用者。
 *
 * 根因是三类结构性问题：
 *   ① **吞**：`.catch(() => {})`、`log("warn", ...)` 后 `return null`，
 *      错误只进日志，永不进入「上抛 → VS Code → UI」通道。
 *   ② **塌**：所有错误码经 `e?.code ?? InternalError` 统一塌成 -32603，
 *      上游无法据此区分「该重试（瞬态）」还是「该改配置（账号/网络）」。
 *   ③ **裸**：上游 API 的原始报错（如 `[AUTH] 403: 您的 IP 不在令牌允许访问的列表中`）
 *      原样当 message 塞回 UI —— 用户没有任何可执行指引。
 *
 * 本模块提供三件事：
 *   1. `BridgeError`      —— 带 `code` / `kind` / `hint` / `cause` 的结构化错误
 *   2. `classifyError()`  —— 把任意异常（含上游字符串报错）归一成 `BridgeError`
 *   3. `toRpcError()`     —— 转成 VS Code（codex app-server 协议）能消费的 JSON-RPC error，
 *                           **把用户可读的 `hint` 显式注入 message**，确保 UI 一定看得到指引
 *
 * ─── 与官方协议的关系 ────────────────────────────────────────────────
 * codex app-server 的 JSON-RPC error 形状是 `{ code, message, data? }`（沿用 JSON-RPC 2.0）。
 * VS Code `codexAgent.ts` 在 `_handleError` 里会把 `error.message` **直接展示给用户**
 * （`vscode.window.showErrorMessage` 路径），因此 message 必须是**人能读懂的**。
 * 故本模块把「原始报错」放 `data.raw`，「可执行指引」放 message。
 */

/** 错误大类 —— 决定 UI 侧该给什么建议，也决定桥是否该重试 */
export const ErrorKind = {
  AUTH: "auth",                 // 凭据/白名单被拒（改配置，不是软件 bug）
  NETWORK: "network",           // 连不上/超时/DNS（可重试）
  RATE_LIMIT: "rate_limit",     // 限流（可退避重试）
  TRANSIENT: "transient",       // 文件占用/进程竞态（可重试）
  CONTRACT: "contract",         // 桥与 VS Code 的字段契约不一致（我们的 bug）
  CONFIG: "config",             // 用户配置非法（模型名/档位/profile）
  UPSTREAM: "upstream",         // 上游模型服务报错（透传但加指引）
  INTERNAL: "internal",         // 桥自身未知异常
  CANCELLED: "cancelled",       // 用户主动中断
};

/** 每个大类 → 给用户的一句「我该怎么办」 */
const KIND_HINT = {
  [ErrorKind.AUTH]:
    "凭据或 IP 白名单被上游拒绝。请检查：① API Key 是否有效；② 本机 IP 是否已加入令牌白名单" +
    "（可用门户的 IP 同步脚本刷新）。这不是软件故障。",
  [ErrorKind.NETWORK]:
    "网络不通或超时。请检查代理/网络后重试；若持续失败，可在日志中搜 [flow] ! 查看具体端点。",
  [ErrorKind.RATE_LIMIT]:
    "上游限流。稍等片刻再发一次即可。",
  [ErrorKind.TRANSIENT]:
    "遇到瞬态资源占用（多见于 DSH 配置文件被另一实例占用）。桥已自动重试；若仍失败请关闭其他 DSH 窗口后重试。",
  [ErrorKind.CONTRACT]:
    "桥与 VS Code 的协议字段不一致（桥侧缺陷）。请把此条连同日志 [flow] ! CONTRACT 一并反馈，重启 VS Code 可临时恢复。",
  [ErrorKind.CONFIG]:
    "配置不合法。请检查所选模型 / 权限档位是否与 DSH 侧声明一致。",
  [ErrorKind.UPSTREAM]:
    "上游模型服务返回错误。若为 4xx 请检查账号额度与模型权限；5xx 可重试。",
  [ErrorKind.INTERNAL]:
    "桥内部异常。请查看日志中 [flow] ! 的完整堆栈并反馈。",
  [ErrorKind.CANCELLED]: "本轮已取消。",
};

/** 大类 → JSON-RPC 错误码（尽量贴合语义；VS Code 主要看 message） */
const KIND_RPC_CODE = {
  [ErrorKind.AUTH]: -32001,        // 自定义：鉴权
  [ErrorKind.NETWORK]: -32002,     // 自定义：网络
  [ErrorKind.RATE_LIMIT]: -32003,  // 自定义：限流
  [ErrorKind.TRANSIENT]: -32004,   // 自定义：瞬态
  [ErrorKind.CONTRACT]: -32602,    // InvalidParams（契约不符≈参数不合法）
  [ErrorKind.CONFIG]: -32602,
  [ErrorKind.UPSTREAM]: -32010,
  [ErrorKind.CANCELLED]: -32800,   // JSON-RPC 惯例的 Request cancelled
  [ErrorKind.INTERNAL]: -32603,
};

export class BridgeError extends Error {
  /**
   * @param {string} message  面向开发者的简要描述
   * @param {object} [opts]
   * @param {string} [opts.kind]   ErrorKind 之一
   * @param {number} [opts.code]   显式 JSON-RPC code（不传则按 kind 推导）
   * @param {string} [opts.hint]   面向用户的可执行指引（不传则按 kind 取默认）
   * @param {object} [opts.data]   附加结构化数据（stage / method / raw …）
   * @param {Error}  [opts.cause]  原始异常（保留堆栈）
   * @param {boolean}[opts.retryable]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = "BridgeError";
    this.kind = opts.kind ?? ErrorKind.INTERNAL;
    this.code = opts.code ?? KIND_RPC_CODE[this.kind] ?? -32603;
    this.hint = opts.hint ?? KIND_HINT[this.kind] ?? "";
    this.data = opts.data ?? undefined;
    this.retryable = opts.retryable ?? (this.kind === ErrorKind.TRANSIENT || this.kind === ErrorKind.NETWORK || this.kind === ErrorKind.RATE_LIMIT);
    if (opts.cause) this.cause = opts.cause;
  }
}

const isBridgeError = (e) => e instanceof BridgeError || (e && e.name === "BridgeError");

/**
 * 把任意异常归一成 `BridgeError`。
 *
 * ★ 关键：**上游 ACP/模型服务的报错是字符串**（如 `[AUTH] 403: 您的 IP 不在…`），
 *   不带 `code`。若不在此处按**文案特征**分类，它会以 `INTERNAL` 抵达 UI，
 *   用户只能看到一句英文技术串 —— 这正是"异常无法反馈给使用者"的主因之一。
 */
export function classifyError(e, ctx = {}) {
  if (isBridgeError(e)) {
    // 已分类过：补上 stage/method 上下文即可
    if (ctx.stage || ctx.method) {
      e.data = { ...(e.data ?? {}), ...(ctx.stage ? { stage: ctx.stage } : {}), ...(ctx.method ? { method: ctx.method } : {}) };
    }
    return e;
  }

  const raw = e == null ? "" : String(e?.message ?? e);
  const low = raw.toLowerCase();
  const stage = ctx.stage ? `[${ctx.stage}] ` : "";
  const method = ctx.method ? ` (${ctx.method})` : "";

  // ── 按文案/码特征分类（顺序敏感：先窄后宽）──────────────────────────
  let kind = ErrorKind.INTERNAL;

  if (/\[auth\]|\b401\b|\b403\b|unauthor|forbidden|invalid[_ ]?api[_ ]?key|ip 不在|白名单|permission denied.*key/i.test(raw)) {
    kind = ErrorKind.AUTH;
  } else if (/\b429\b|rate ?limit|too many requests|quota exceeded|额度/i.test(raw)) {
    kind = ErrorKind.RATE_LIMIT;
  } else if (/EPERM|EBUSY|EACCES|resource busy|另一进程|被占用/i.test(raw)) {
    kind = ErrorKind.TRANSIENT;
  } else if (/\b5\d\d\b|internal server error|bad gateway|service unavailable/i.test(raw)) {
    kind = ErrorKind.UPSTREAM;
  } else if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed|timeout|超时/i.test(raw)) {
    kind = ErrorKind.NETWORK;
  } else if (/transport closed|exited \(code=|dsh channel unavailable|child.*exit|process.*gone/i.test(raw)) {
    kind = ErrorKind.TRANSIENT;
  } else if (/MethodNotFound|Method not found|-32601|not implemented|未实现/i.test(raw)) {
    kind = ErrorKind.CONTRACT;
  } else if (/unknown thread|unknown session|未知会话|未知线程/i.test(raw)) {
    kind = ErrorKind.CONFIG;
  } else if (/CANCELLED|aborted|cancel/i.test(low)) {
    kind = ErrorKind.CANCELLED;
  } else if (/\b4\d\d\b/.test(raw)) {
    kind = ErrorKind.UPSTREAM;   // 其它 4xx 归上游
  }

  // 保留原始 ACP 错误码（若对端给了数字码）
  const rawCode = typeof e?.code === "number" ? e.code : undefined;

  return new BridgeError(`${stage}${raw || "unknown error"}${method}`, {
    kind,
    code: rawCode,
    data: { ...(ctx.stage ? { stage: ctx.stage } : {}), ...(ctx.method ? { method: ctx.method } : {}), raw },
    cause: e instanceof Error ? e : undefined,
  });
}

/**
 * 转成可写入 JSON-RPC 的 `error` 对象。
 *
 * ★ message 里**必须带 hint** —— 因为 VS Code 把 `error.message` 直接展示给用户，
 *   这是"让异常抵达使用者"的最后也是唯一一跳。
 * ★ 原始报错移到 `data.raw`，避免丢失排查线索。
 * ★ 附带 `data.kind` / `data.retryable`，供上游做策略决策（如自动重试）。
 */
export function toRpcError(e, ctx = {}) {
  const be = classifyError(e, ctx);
  const parts = [be.message];
  if (be.hint) parts.push(`\n\n👉 ${be.hint}`);
  if (be.retryable) parts.push("（可重试）");
  return {
    code: be.code,
    message: parts.join(""),
    data: {
      kind: be.kind,
      retryable: be.retryable,
      ...(be.data ?? {}),
    },
  };
}

/** 便于 handler 直接 return 的糖：`return rpcFail(e, {stage, method})` */
export function rpcFail(e, ctx = {}) {
  return { __error: toRpcError(e, ctx) };
}

/* ────────────────────────────────────────────────────────────────────────
 * ★★★ 「好消息型错误」白名单 —— 幂等信号，不是失败（2026-10-16 新增）
 *
 * ─── 症状与根因（真机血案）────────────────────────────────────────────
 *   用户报 `错误: (CodexResumeFailed) Invalid params: session is already active: <uuid> (thread/resume)`，
 *   且**此后该会话再也发不出消息**。
 *
 *   日志链（agenthost.log 20261016T183837）：
 *     · 18:39:11  prewarm ready threadId=ede15e23      ← 预热点火建了 DSH 会话
 *     · 18:39:59  restarting thread ede15e23 to apply client tools
 *                 → thread/unsubscribe{threadId:ede15e23}（桥空实现，DSH 侧会话仍 active）
 *                 → thread/start（新建另一会话；ede15e23 仍在 DSH 内存里活着）
 *     · 18:40:12  thread/unsubscribe → thread/resume
 *                 → DSH 回 `Invalid params: session is already active`   ← 崩点
 *
 *   机制（对照 VS Code 官方源码 codexAgent.ts:6895-6970）：
 *     `unsubscribeBeforeResume` 只让 VS Code 发 **`thread/unsubscribe`**，
 *     而 codex app-server 的 unsubscribe 语义是「**本 app-server 释放订阅**」，
 *     **并不要求后端销毁会话**。原版 codex 会照此重载 rollout，故 resume 能成功；
 *     而我们的桥把会话托管给 DSH（长生命周期进程），
 *     **unsubscribe 是空实现** ⇒ 会话在 DSH 侧仍是 active ⇒ resume 被拒。
 *
 * ─── 为什么这不是「失败」──────────────────────────────────────────────
 *   `thread/resume` 的**目的**是「让这个会话可用，以便随后 turn/start」。
 *   报 `already active` 恰恰说明**会话就是活的** —— 目的已达成。
 *   把它当失败上抛，等于「因为门本来就是开着的，所以判定进不去」，
 *   而且 VS Code 会因此把该 chat 标记为 resume 失败并**停用后续发送**（用户直接卡死）。
 *
 * ─── 判据表（严格按文案，不宽泛）──────────────────────────────────────
 *   ✅ 幂等：`session is already active` / `thread … already has an active writer`
 *   ❌ 仍报错：`session cwd does not match`（真冲突，会话状态与请求不符）
 *             `no rollout found`（有专门的重建路径，见 codexAgent._replaceMissingRolloutBacking）
 *
 * ★ 同源设计：VS Code 自己就有这个范式 —— `_replaceMissingRolloutBacking()` 里
 *   `if (/no rollout found for thread id/i.test(error.message)) return {};`
 *   **把特定上游错误改写成成功**，而不是抛给上层。本节是它在桥侧的对应物。
 * ──────────────────────────────────────────────────────────────────────── */

/** 幂等成功信号：命中即代表「该会话已处于目标状态」，调用方可当成功处理 */
const IDEMPOTENT_PATTERNS = [
  /session is already active/i,
  /thread\s+\S+\s+already has an active writer/i,
];

/**
 * 判断一个异常是否是「幂等信号」（目标状态已达成，非失败）。
 *
 * @param {unknown} e  原始异常或错误消息
 * @returns {{ idempotent: true, reason: string } | { idempotent: false }}
 */
export function asIdempotent(e) {
  const raw = e == null ? "" : String(e?.message ?? e);
  for (const re of IDEMPOTENT_PATTERNS) {
    const m = raw.match(re);
    if (m) return { idempotent: true, reason: m[0] };
  }
  return { idempotent: false };
}
