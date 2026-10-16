/**
 * JSON-RPC 2.0 over stdio transport —— 形态照抄 VS Code codex app-server 客户端的传输层。
 *
 * VS Code 侧证据（agentHostMain.js）：
 *   _listenToStdout(): stdout.on("data") → 累加 _buf → 按 "\n" 分帧 → JSON.parse → _dispatch
 *   _writeMessage(e):  transport.stdin.write(JSON.stringify(e) + "\n")
 *   _dispatch(e):      有 id+result/error → 响应（查 _pending）；有 id+method → 反向请求；仅 method → 通知
 *   错误码：-32601 Method not found；-32603 内部错误
 *
 * 本模块实现「服务端」侧（我们是被 VS Code spawn 的 provider）：
 *   - 从 stdin 收 VS Code 的请求/通知
 *   - 往 stdout 写响应/通知
 *   - 也可反向向 VS Code 发请求（如 item 的 requestApproval 系列）
 */

import { EventEmitter } from "node:events";
import { toRpcError } from "./errors.mjs";

export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
};

export class JsonRpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/**
 * 把一个可读流 + 可写流包装成 JSON-RPC 端点。
 * @param {NodeJS.ReadableStream} input  例如 process.stdin
 * @param {NodeJS.WritableStream} output 例如 process.stdout
 * @param {{ log?: (level:string, msg:string)=>void, label?: string, flowLog?: boolean }} [opts]
 */
export function createStdioRpcEndpoint(input, output, opts = {}) {
  const label = opts.label ?? "rpc";
  const log = opts.log ?? ((level, msg) => process.stderr.write(`[${label}] ${level}: ${msg}\n`));

  /**
   * ★★★ 流程日志（统一打点，2026-10-16 新增）—— **所有 RPC 方法自动覆盖，无需逐个加**。
   *
   * 为什么放在传输层而不是各 handler：排"发消息无响应"时，最需要先回答的是
   *   **"请求到桥了吗 / 桥应答了吗 / 卡在哪两个方法之间"**。
   * 在传输层打点 ⇒ 一次改动覆盖全部方法，且时序天然准确。
   *
   * 输出形态（单行、可 grep）：
   *   [flow] ⇢ rpc.in  #12 thread/start
   *   [flow] ⇠ rpc.out #12 thread/start (23.4ms)
   *   [flow] ! rpc.err #12 thread/start :: <原因>
   *   [flow] · rpc.notify turn/completed
   */
  const FLOW = opts.flowLog !== false;
  const _t0 = new Map();   // id → hrtime

  let buf = "";
  let nextId = 1;
  const pending = new Map();           // 我们发出的请求（反向请求）的等待表
  const requestHandlers = new Map();   // 对端请求的处理表
  const notificationHandlers = new Map();
  const emitter = new EventEmitter();
  let closed = false;

  // ---- 出站 ----
  function writeMessage(msg) {
    if (closed) return false;
    try {
      output.write(JSON.stringify(msg) + "\n");
      return true;
    } catch (e) {
      log("error", `write failed: ${e?.message ?? e}`);
      return false;
    }
  }

  function writeResult(id, result) {
    writeMessage({ jsonrpc: "2.0", id, result });
  }

  function writeError(id, code, message, data) {
    writeMessage({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
  }

  /** 我们主动向对端（VS Code）发请求 —— 用于 provider→host 的审批类调用 */
  function request(method, params, { timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      let timer;
      pending.set(id, {
        resolve: (v) => { if (timer) clearTimeout(timer); resolve(v); },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
        method,
      });
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (pending.delete(id)) reject(new JsonRpcError(JsonRpcErrorCode.InternalError, `request timeout: ${method}`));
        }, timeoutMs);
      }
      writeMessage({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** 我们主动向对端发通知 */
  function notify(method, params) {
    if (FLOW) log("info", `[flow] · rpc.notify ${method}`);
    writeMessage({ jsonrpc: "2.0", method, params });
  }

  // ---- 入站 ----
  function dispatch(msg) {
    if (!msg || typeof msg !== "object") {
      log("warn", `unrecognized message: ${JSON.stringify(msg)?.slice(0, 200)}`);
      return;
    }
    const hasId = Object.prototype.hasOwnProperty.call(msg, "id");
    const hasMethod = typeof msg.method === "string";

    // 响应（我们发出的请求的应答）
    if (hasId && !hasMethod) {
      if (typeof msg.id !== "number") {
        log("warn", `unsolicited response id=${msg.id}`);
        return;
      }
      const entry = pending.get(msg.id);
      if (!entry) {
        log("warn", `unsolicited response id=${msg.id}`);
        return;
      }
      pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new JsonRpcError(msg.error.code, msg.error.message, msg.error.data));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // 请求（有 id + method）
    if (hasId && hasMethod) {
      // ★ 支持通配兜底 "*"：精确 handler 优先；无则交兜底（可返回语义化空值而非 MethodNotFound）。
      //   血案（2026-10-11）：此前无 "*" 支持 ⇒ 未实现方法一律被这里拦成 MethodNotFound，
      //   上游（VS Code）当致命错误抛 UI（如 thread/read 缺失 → Session was never created 刷屏）。
      const handler = requestHandlers.get(msg.method) ?? requestHandlers.get("*");
      if (!handler) {
        if (FLOW) log("warn", `[flow] ! rpc.MISS #${msg.id} ${msg.method} :: 无 handler 且无 "*" 兜底`);
        writeError(msg.id, JsonRpcErrorCode.MethodNotFound, `Method not found: ${msg.method}`);
        return;
      }
      // ── FLOW：入站请求打点（**"请求到桥了吗"的唯一权威判据**）──
      if (FLOW) {
        _t0.set(msg.id, process.hrtime.bigint());
        log("info", `[flow] ⇢ rpc.in  #${msg.id} ${msg.method}`);
      }
      Promise.resolve()
        .then(() => handler(msg.params, msg.id, msg.method))
        .then((result) => {
          if (FLOW) {
            const t0v = _t0.get(msg.id); _t0.delete(msg.id);
            const ms = t0v ? (Number(process.hrtime.bigint() - t0v) / 1e6).toFixed(1) : "?";
            log("info", `[flow] ⇠ rpc.out #${msg.id} ${msg.method} (${ms}ms)`);
          }
          // handler 允许返回 { __error: {...} } 表示错误
          if (result && typeof result === "object" && result.__error) {
            writeError(msg.id, result.__error.code ?? JsonRpcErrorCode.InternalError, result.__error.message ?? "error", result.__error.data);
          } else {
            writeResult(msg.id, result);
          }
        })
        .catch((e) => {
          if (FLOW) { _t0.delete(msg.id); log("error", `[flow] ! rpc.err #${msg.id} ${msg.method} :: ${e?.message ?? e}`); }
          log("error", `handler for ${msg.method} threw: ${e?.message ?? e}`);
          // ★★★ 统一错误分类（2026-10-16）：此前 `e?.code ?? InternalError` 把所有异常
          //   塌成 -32603 且 message 无指引 ⇒ 上游/UI 无法区分「该重试」还是「该改配置」。
          //   现在经 toRpcError 归一：带上 kind / retryable，并把**用户可读 hint 注入 message**
          //   （VS Code 直接把 error.message 展示给用户，这是抵达使用者的最后一跳）。
          const rpcErr = toRpcError(e, { method: msg.method });
          writeError(msg.id, rpcErr.code, rpcErr.message, rpcErr.data);
        });
      return;
    }

    // 通知（仅 method）
    if (hasMethod) {
      const handler = notificationHandlers.get(msg.method);
      if (!handler) {
        log("warn", `dropping unhandled notification: ${msg.method}`);
        return;
      }
      try {
        handler(msg.params);
      } catch (e) {
        log("error", `notification handler ${msg.method} threw: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    log("warn", `unrecognized message: ${JSON.stringify(msg).slice(0, 200)}`);
  }

  function onData(chunk) {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        log("error", `parse error on line: ${trimmed.slice(0, 200)}`);
        continue;
      }
      dispatch(parsed);
    }
  }

  input.on("data", onData);
  const onEnd = () => {
    if (closed) return;
    closed = true;
    const msg = "transport closed";
    for (const [, entry] of pending) entry.reject(new JsonRpcError(JsonRpcErrorCode.InternalError, `${msg}; request ${entry.method} aborted`));
    pending.clear();
    emitter.emit("close");
  };
  input.on("end", onEnd);
  input.on("close", onEnd);

  /**
   * ★★★ 立即中止全部在途请求（2026-10-16 新增）。
   *
   * 用途：DSH 子进程死亡/spawn 失败时，桥必须**立刻**让所有等待中的 `dsh.*` 请求
   *   以错误收场 —— 否则它们会一直 pending 到超时（最长 120s），
   *   用户界面上就是"永久转圈且没有任何提示"。
   * 与 `onEnd` 的区别：不依赖流事件（子进程被 kill 时 stdout 的 end/close 可能不触发或延迟）。
   * @param {string} reason
   */
  function abortAll(reason = "aborted") {
    const n = pending.size;
    for (const [, entry] of pending) {
      entry.reject(new JsonRpcError(JsonRpcErrorCode.InternalError, `${reason}; request ${entry.method} aborted`));
    }
    pending.clear();
    if (n > 0) log("warn", `abortAll: ${n} pending request(s) rejected (${reason})`);
    return n;
  }
  // 把中止能力暴露给调用方（桥在子进程 exit 回调里调用）
  emitter.abortAll = abortAll;

  return {
    onRequest(method, handler) {
      requestHandlers.set(method, handler);
      return () => { if (requestHandlers.get(method) === handler) requestHandlers.delete(method); };
    },
    onNotification(method, handler) {
      notificationHandlers.set(method, handler);
      return () => { if (notificationHandlers.get(method) === handler) notificationHandlers.delete(method); };
    },
    onClose(cb) { emitter.once("close", cb); },
    request,
    notify,
    abortAll,
    writeResult,
    writeError,
    log,
    get isClosed() { return closed; },
    get pendingCount() { return pending.size; },
  };
}
