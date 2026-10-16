#!/usr/bin/env node
/**
 * 在 Agents 窗口 renderer 里，通过 VS Code 的服务注册表调用
 *   customizationHarnessService.getCustomAgents(sessionResource, token)
 * 直接看真源返回什么 —— 这是判定「为什么下拉没有 preset」的一锤定音。
 *
 * 手段：VS Code renderer 暴露 `window.vscode`? 通常不暴露。
 * 备用：从已注册的 harness provider 列表里找 agenthost-dsh，直接调它的方法。
 */
const PORT = process.argv[2] || "9333";
const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
const pg = list.filter((p) => p.type === "page").find((p) => /sessions/i.test(p.url || ""));
console.log("target:", pg.title, "|", pg.url.slice(0, 90));
const ws = new WebSocket(pg.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data.toString()); if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Runtime.enable");
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text, desc: r.result.exceptionDetails.exception?.description };
  return r.result?.result?.value;
};

// ① 探测 renderer 可用的服务获取入口
const probe = await ev("(() => {"
  + "const w = window;"
  + "const cand = Object.keys(w).filter(k=>/vscode|service|registry/i.test(k));"
  + "return JSON.stringify({ cand, hasVscode: typeof w.vscode, amdRequire: typeof w.require, define: typeof w.define, _VSCODE_: typeof w._VSCODE_ });"
  + "})()");
console.log("① renderer 入口探针:", probe);

// ② 尝试通过 DOM / 事件桥找服务（VS Code 常见：window._VSCODE_NLS_CONFIG 等）
const probe2 = await ev("(() => {"
  + "const out={};"
  + "for (const k of ['_VSCODE_NLS_CONFIG','_VSCODE_FILE_ROOT','_VSCODE_PID','vscodeWebviewPlaygroundNonce','MonacoEnvironment']) out[k]=typeof window[k];"
  + "return JSON.stringify(out);"
  + "})()");
console.log("② 其他全局:", probe2);

ws.close(); process.exit(0);
