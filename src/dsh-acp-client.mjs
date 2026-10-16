/**
 * DSH ACP 客户端 —— 桥内部 spawn `dsh --profile acp`，用 ACP 协议与之对话。
 *
 * DSH ACP 真实接口面（实测，来自 @agentclientprotocol/sdk@1.4.0 AGENT_METHODS + dsh-acp 注册表）：
 *   agent 侧 onRequest（桥→DSH 请求）：
 *     initialize                    { protocolVersion, clientCapabilities, clientInfo }
 *     session/new                   { cwd, mcpServers }        → { sessionId, configOptions }
 *     session/list                  {}                          → { sessions: [...] }
 *     session/resume                { sessionId, cwd, mcpServers? } → { configOptions }
 *     session/close                 { sessionId }
 *     session/set_config_option     { sessionId, configId, value } → { configOptions }
 *     session/prompt                { sessionId, prompt:[...] }
 *   agent 侧 onNotification（桥→DSH 通知）：
 *     session/cancel                { sessionId }
 *
 *   client 侧（DSH→桥请求，桥必须实现）：
 *     session/request_permission    → { outcome: { outcome:"selected", optionId } }
 *     fs/read_text_file             → { content }
 *     fs/write_text_file            → {}
 *     terminal/create|output|wait_for_exit|kill|release
 *     elicitation/create|complete
 *   client 侧（DSH→桥通知）：
 *     session/update                { sessionId, update: { sessionUpdate: "...", ... } }
 *
 * ★ initialize 回执实测（本机 v0.2.0-rc.2）：
 *   { protocolVersion:1,
 *     agentInfo:{ name:"deepseek-harness-acp", version:"0.0.1" },
 *     agentCapabilities:{ mcpCapabilities:{http:true},
 *                         promptCapabilities:{image:false,audio:false,embeddedContext:false},
 *                         sessionCapabilities:{close:{},list:{},resume:{}} },
 *     authMethods:[] }
 */

import { spawn } from "node:child_process";
import { createStdioRpcEndpoint, JsonRpcError, JsonRpcErrorCode } from "./rpc.mjs";
import { BridgeError, ErrorKind, classifyError, toRpcError } from "./errors.mjs";
import { DSH_AGENT } from "./method-names.mjs";

/**
 * ★ 探针专用：单调 + wall-clock 双锚时间戳（2026-10-16）。
 *   用于把「桥→DSH 发了什么、DSH 回了什么、谁先谁后」变成不可争辩的字节证据。
 */
const _PROBE_T0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : 0;
export function probeT() {
  const wall = Date.now();
  const mono = ((typeof performance !== "undefined" && performance.now) ? performance.now() : 0) - _PROBE_T0;
  return `${wall}/${mono.toFixed(1)}`;
}

export class DshAcpClient {
  /**
   * @param {object} cfg
   * @param {string} cfg.nodePath    node 可执行路径
   * @param {string} cfg.dshBinPath  dsh 的 lib/bin.js 路径
   * @param {string} cfg.profile     profile 名（默认 "acp"）
   * @param {string} cfg.cwd         工作目录
   * @param {{log?:Function}} [cfg]
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.log = cfg.log ?? ((l, m) => process.stderr.write(`[dsh-acp] ${l}: ${m}\n`));
    this.child = null;
    this.rpc = null;
    this.serverInfo = null;
    this.clientHandlers = new Map();     // DSH→桥 请求处理
    this.updateListeners = new Set();    // session/update 订阅
    this._exitListeners = new Set();     // ★ 子进程死亡订阅（桥用它向上报异常）
    this.closed = false;
  }

  /**
   * ★ 订阅「DSH 子进程死亡 / spawn 失败」——桥借此推通知给 VS Code，
   *   让 UI 立刻知道后端挂了，而不是等请求超时。
   * @param {(err: BridgeError, info: object) => void} cb
   */
  onExit(cb) {
    this._exitListeners.add(cb);
    return () => this._exitListeners.delete(cb);
  }

  /** 设置桥对 DSH 请求的处理（session/request_permission / fs/* / terminal/* 等） */
  setClientRequestHandler(method, handler) {
    this.clientHandlers.set(method, handler);
  }

  onSessionUpdate(cb) {
    this.updateListeners.add(cb);
    return () => this.updateListeners.delete(cb);
  }

  async start() {
    const args = [this.cfg.dshBinPath, "--profile", this.cfg.profile ?? "acp"];
    this.log("info", `spawning: ${this.cfg.nodePath} ${args.join(" ")} (cwd=${this.cfg.cwd})`);
    this.child = spawn(this.cfg.nodePath, args, {
      cwd: this.cfg.cwd,
      env: { ...this.cfg.env ?? process.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (d) => this.log("stderr", String(d).trimEnd()));

    this.child.on("exit", (code, signal) => {
      this.log("warn", `dsh acp exited (code=${code}, signal=${signal})`);
      this.closed = true;
      // ★★★ 异常上报（2026-10-16）：子进程意外死亡以前**只进日志**，UI 完全无感 ——
      //   用户只看到"转圈"，直到下一个请求超时（最长 120s）才知道出事了。
      //   现在：① 立刻 reject 所有在途请求（不等超时）；② 触发 onExit 回调 → 桥推通知给 VS Code。
      const err = new BridgeError(
        `DSH 后端进程意外退出（code=${code}${signal ? `, signal=${signal}` : ""}）`,
        {
          kind: code === 0 ? ErrorKind.TRANSIENT : ErrorKind.INTERNAL,
          data: { exitCode: code, signal, stage: "dsh-child-exit" },
          retryable: true,
        },
      );
      try { this.rpc?.abortAll?.(`dsh acp exited (code=${code})`); } catch { /* ignore */ }
      for (const cb of this._exitListeners) {
        try { cb(err, { code, signal }); } catch (e) { this.log("error", `exit listener threw: ${e?.message ?? e}`); }
      }
    });
    // ★ spawn 本身失败（node 路径错 / dshBinPath 不存在）以前**没有任何处理**：
    //   spawn 是异步的，失败走 'error' 事件；不监听 ⇒ 桥静默挂着，UI 永久空转。
    this.child.on("error", (e) => {
      this.log("error", `dsh acp spawn error: ${e?.message ?? e}`);
      this.closed = true;
      const err = new BridgeError(`无法启动 DSH 后端进程：${e?.message ?? e}`, {
        kind: /ENOENT/.test(String(e?.code ?? e?.message)) ? ErrorKind.CONFIG : ErrorKind.INTERNAL,
        data: { stage: "dsh-spawn", nodePath: this.cfg.nodePath, dshBinPath: this.cfg.dshBinPath },
        cause: e,
      });
      try { this.rpc?.abortAll?.(`dsh acp spawn error`); } catch { /* ignore */ }
      for (const cb of this._exitListeners) {
        try { cb(err, { spawnError: true }); } catch (ee) { this.log("error", `exit listener threw: ${ee?.message ?? ee}`); }
      }
    });

    // ★ 参数顺序：(input=读对端输出, output=写对端输入)
    this.rpc = createStdioRpcEndpoint(this.child.stdout, this.child.stdin, {
      label: "bridge→dsh",
      log: this.log,
    });

    // 注册 client 侧请求（DSH → 桥）
    for (const [method, handler] of this.clientHandlers) {
      this.rpc.onRequest(method, handler);
    }
    // session/update 通知
    this.rpc.onNotification(DSH_AGENT.sessionUpdate, (params) => {
      for (const cb of this.updateListeners) {
        try { cb(params); } catch (e) { this.log("error", `update listener threw: ${e?.message ?? e}`); }
      }
    });

    return this;
  }

  async initialize(clientCapabilities, clientInfo) {
    const res = await this.rpc.request(DSH_AGENT.initialize, {
      protocolVersion: 1,
      clientCapabilities: clientCapabilities ?? {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
      clientInfo: clientInfo ?? { name: "vscode-ahp-dsh-bridge", version: "0.1.0" },
    });
    this.serverInfo = res;
    this.log("info", `initialize ok: agent=${res?.agentInfo?.name} v=${res?.agentInfo?.version} protocol=${res?.protocolVersion}`);
    return res;
  }

  async newSession({ cwd, mcpServers }) {
    // ★ 探针 P1（2026-10-16）：请求体 + DSH 回执真值（currentModel）双向落盘
    this.log("info", `[probe-model] T=${probeT()} P1 session/new REQ hasModelField=false keys=[cwd,mcpServers] cwd=${cwd}`);
    const res = await this.rpc.request(DSH_AGENT.sessionNew, { cwd, mcpServers: mcpServers ?? [] });
    let curModel = null, modelIds = [];
    try {
      const opts = res?.configOptions;
      const arr = Array.isArray(opts) ? opts : (opts ? Object.values(opts) : []);
      for (const o of arr) {
        if (!o) continue;
        const id = o.id ?? o.configId ?? o.key;
        if (id === "model" || /model/i.test(String(id ?? ""))) {
          curModel = o.currentValue ?? o.value ?? o.selected ?? null;
          const vals = o.options ?? o.values ?? o.enum ?? [];
          if (Array.isArray(vals)) modelIds = vals.map((v) => (v && typeof v === "object") ? (v.value ?? v.id ?? v.name) : v);
        }
      }
    } catch (e) { curModel = `<probe-parse-error:${e?.message ?? e}>`; }
    this.log("info", `[probe-model] T=${probeT()} P1 session/new RESP sessionId=${res?.sessionId} currentModel=${JSON.stringify(curModel)} modelCount=${modelIds.length}`);
    return res;
  }

  /**
   * 列会话。★ 2026-10-15：支持透传分页/限额参数（ACP `session/list` 收 `{ cursor?, limit? }`）。
   *   实测 DSH 返回 `{ sessions:[...], nextCursor? }`；旧版/不收参数时忽略即可（向后兼容）。
   * @param {{cursor?:string, limit?:number}} [params]
   */
  async listSessions(params) {
    const req = {};
    if (params && typeof params === "object") {
      if (params.cursor !== undefined) req.cursor = params.cursor;
      if (params.limit !== undefined) req.limit = params.limit;
    }
    return this.rpc.request(DSH_AGENT.sessionList, req);
  }

  async resumeSession(params) {
    return this.rpc.request(DSH_AGENT.sessionResume, params);
  }

  async closeSession(sessionId) {
    return this.rpc.request(DSH_AGENT.sessionClose, { sessionId });
  }

  async setConfigOption(sessionId, configId, value) {
    // ★ P6 探针（2026-10-16）：模型设置是「选 A 跑 B」的最后一道关卡。
    //   此前只靠 `★ 模型已落地` 的乐观日志判成功（那只是"桥调用没抛异常"），
    //   **从不校验 DSH 回执**。这里把「请求值 / 回执真值 / 回读校验」三点一次打全。
    this.log("info", `[probe-model] T=${probeT()} P6 set_config_option REQ sessionId=${sessionId} configId=${configId} value=${JSON.stringify(value)}`);
    let res;
    try {
      res = await this.rpc.request(DSH_AGENT.sessionSetConfigOption, { sessionId, configId, value });
    } catch (e) {
      this.log("error", `[probe-model] T=${probeT()} P6 set_config_option ERR value=${JSON.stringify(value)} code=${e?.code ?? "?"} msg=${String(e?.message ?? e).slice(0, 200)}`);
      throw e;
    }
    // 回读：DSH 回执的 configOptions 才是「真正生效」的唯一判据。
    let backModel = null;
    try {
      const opts = res?.configOptions;
      if (Array.isArray(opts)) {
        const mo = opts.find((o) => o && (o.id === "model" || o.configId === "model" || o.name === "model"));
        backModel = mo?.currentValue ?? null;
      } else if (opts && typeof opts === "object") {
        backModel = opts.model ?? null;
      }
    } catch { /* 观测不影响主流程 */ }
    const ok = backModel !== null && JSON.stringify(backModel) === JSON.stringify(value);
    this.log("info", `[probe-model] T=${probeT()} P6 set_config_option RESP value=${JSON.stringify(value)} DSH回读=${JSON.stringify(backModel)} ${ok ? "✅匹配" : "❌不匹配(DSH 未采纳!)"}`);
    return res;
  }

  /**
   * ★ 2026-10-15 新增：取 per-model 能力元数据（DSH 侧扩展方法）。
   *
   * 背景：ACP 标准的 `configOptions.model` 选项只有 value/name/description，
   *   「多模态 / 思考等级 / 上下文大小」在标准面上**结构性地不存在**。
   *   DSH 内部有真值（`llm.resolveModelInfo`），但从不越过进程边界。
   * 修法：DSH 侧新增扩展方法 `_deepseek/models`（模块 `model-info.ts`），
   *   一次性汇总全部 provider×model 的 contextWindow / maxOutputTokens /
   *   supportsVision / reasoningEfforts。名字以 `_` 开头 = ACP 扩展命名空间。
   *
   * 向后兼容：对接**旧版 DSH**（无此方法）时返回 `-32601 Method not found`，
   *   本方法捕获后返回 null，调用方降级为「无能力数据」，不影响既有功能。
   * @returns {Promise<{models: Array}|null>}
   */
  async modelsInfo() {
    try {
      const res = await this.rpc.request(DSH_AGENT.modelsInfo, {});
      return res && Array.isArray(res.models) ? res : null;
    } catch (e) {
      this.log("info", `modelsInfo unavailable (${e?.code ?? "?"} ${e?.message ?? e}) — 降级为无能力元数据`);
      return null;
    }
  }

  /**
   * ★★★ 2026-10-15 新增：**per-session 直改沙箱三档**（本桥私有扩展方法）。
   *
   * 与 `modelsInfo` 同构：名字以 `_` 开头 = ACP 扩展命名空间，DSH 侧由我们注入的
   * `_bowei/sandbox-setMode` 处理（补丁工具 `tools/dsh-acp-extension-patch.mjs`）。
   *
   * 为什么需要它：DSH 三档权限有 session pin 机制 —— session 创建时把档位永久写进
   * session 日志，之后写 config/env/patch 都**对当前会话无效**。唯一合法的当场写路径
   * 是 `session.append('sandbox/mode',{mode})`，本方法正是它的 ACP 入口。
   *
   * @returns {Promise<{sessionId:string, mode:string}|null>}
   *   `null` = 对端不支持（-32601），调用方应回退到 profile patch 路线。
   * @throws 其它 DSH 错误（非法 mode / 未知 session 由 DSH 侧校验并抛错）原样上抛。
   */
  async sandboxSetMode(sessionId, mode) {
    try {
      return await this.rpc.request(DSH_AGENT.boweiSandboxSetMode, { sessionId, mode });
    } catch (e) {
      if (e?.code === -32601) {
        this.log("info", `sandboxSetMode unavailable (-32601) — 对端无 _bowei 扩展，将回退 profile patch`);
        return null;
      }
      throw e;
    }
  }

  /** 发起一轮对话。返回后 DSH 会通过 session/update 持续推送 */
  async prompt(sessionId, prompt) {
    // ★ 探针 P2：真正发出去那一轮的时机（与 P1/P3/P4 做时序对齐）
    this.log("info", `[probe-model] T=${probeT()} P2 session/prompt REQ sessionId=${sessionId} firstText=${JSON.stringify(String(prompt?.[0]?.text ?? "").slice(0, 40))}`);
    return this.rpc.request(DSH_AGENT.sessionPrompt, { sessionId, prompt });
  }

  /** 取消当前轮（ACP 里是 notification） */
  cancel(sessionId) {
    this.rpc.notify(DSH_AGENT.sessionCancel, { sessionId });
  }

  /**
   * ★★★ P0-2 根治（2026-10-11，v2 修正版 —— 经 3 轮实测校准）：**优雅关停** DSH 子进程。
   *
   * 血案：VS Code 退出时桥直接 `child.kill()`（Windows 上 = TerminateProcess 硬杀）
   *   ⇒ DSH 没有机会走 `connection.closed → quiesce() → record.close() → sessions.flush()`
   *      这条**进程内、确定性**的刷盘路径
   *   ⇒ 会话目录（catalog）留下一条后端无落盘产物的 dsh 会话
   *   ⇒ 下次启动 UI 订阅该会话 → `Session was never created on the backend` 刷屏。
   *
   * ★ 实测校准（2026-10-11，probe-alive-flush / probe-ab-v2..v5，共 3 组对照）：
   *   - **存活期不刷盘**：子进程活着并完成 prompt 后，120s 内磁盘上无任何产物（已证）。
   *   - **落盘由进程终止触发**，但**滞后极不稳定**：实测 kill→落盘 区间 **~18s ～ ~311s**。
   *   - 硬杀**最终也会落盘**（存在一条延迟写路径），只是**时机不可控**；这正是
   *     "下次启动偶发 never-created" 的根因 —— 写还没落地，UI 已经去订阅了。
   *   - 优雅关停能让 `flush()` 在**进程存活期内**跑完（`dsh-acp` 的 newSession 末尾本就
   *     `await ctx.sessions.flush(...)`；quiesce 亦会逐个 `record.close()` 触发 flush），
   *     从而把"滞后不可控"变成"退出前已完成"。
   *
   * 修法（三级降级，先礼后兵）：
   *   ① 关闭 DSH 的 **stdin**：ACP 服务端读到 EOF → connection.closed → quiesce → flush
   *   ② 等待最多 `graceMs`（默认 8000ms；flush 含 zstd 压缩 + Worker 校验，需留足）
   *   ③ 仍未退出 → 才 `child.kill()` 硬杀（兜底，避免挂死）
   *
   * 返回 Promise，可在需要"确认已退出"时 await（如桥收到 onClose 时）。
   */
  dispose() {
    const child = this.child;
    if (!child || child.killed || child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      // 已退出？直接返回
      try { child.once("exit", finish); } catch { finish(); }
      // ① 优雅：关 stdin（EOF → DSH 自行退出并刷盘）
      try { child.stdin && child.stdin.end(); } catch { /* ignore */ }
      // ② 宽限期内等 exit
      const graceMs = this.cfg.disposeGraceMs ?? 8000;
      const timer = setTimeout(() => {
        // ③ 兜底：硬杀
        try { if (!child.killed && child.exitCode === null) { this.log("warn", "dsh acp 未在宽限期内退出，强制 kill"); child.kill(); } } catch { /* ignore */ }
        // 再给一点时间让 exit 事件落地，然后无论如何 resolve
        setTimeout(finish, 500);
      }, graceMs);
      if (timer.unref) timer.unref();
      // 早退时清掉定时器
      child.once("exit", () => { clearTimeout(timer); finish(); });
    });
  }
}

export { JsonRpcError, JsonRpcErrorCode };
