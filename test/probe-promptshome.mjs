#!/usr/bin/env node
/**
 * 通过 CDP 让 VS Code 自己报出 promptsHome 路径。
 * 手段：VS Code 的 webview/主进程不直接暴露 DI，但我们可以用「命令面板 + 输出」或
 * 读取 window 上的 configuration（prompts 相关设置）来推断。
 *
 * 更可靠：直接检查文件系统候选路径 + 用 promptsService 的 onDidChangeCustomAgents 触发的效果验证。
 */
import fs from "node:fs";
import path from "node:path";

const CDP = process.argv[2] || "9333";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let WS_URL = "";
function sess() {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    let id = 0; const pend = new Map();
    ws.onopen = () => resolve({
      call: (m, p) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); }),
      close: () => ws.close(),
    });
    ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m); pend.delete(m.id); } } catch {} };
    setTimeout(() => { try { ws.close(); } catch {} ; resolve(null); }, 45000);
  });
}
(async () => {
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const w = list.find((x) => /sessions/i.test(x.url || ""));
  WS_URL = w.webSocketDebuggerUrl;
  const c = await sess();
  await c.call("Runtime.enable");
  const ev = async (e) => (await c.call("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;

  // 1) 尝试找到 promptsHome：搜索任何暴露路径的全局/设置
  console.log("=== [1] 探测全局对象 ===");
  console.log(JSON.stringify(await ev(`(() => {
    const out = {};
    out.hasRequire = typeof require !== 'undefined';
    out.globals = Object.keys(window).filter(k=>/prompt|config|workbench|vscode/i.test(k)).slice(0,25);
    // VS Code 的 monaco 环境常暴露在 window.monaco
    out.hasMonaco = !!window.monaco;
    return out;
  })()`), null, 2));

  // 2) 用命令面板查询式：读设置里的 chat.promptFilesLocations
  console.log("\n=== [2] 读 chat 相关设置 ===");
  console.log(JSON.stringify(await ev(`(() => {
    // 尝试从 DOM 的 settings 或 window 取（不一定可见）
    return { note: 'see fs candidates below' };
  })()`), null, 2));

  // 3) 文件系统候选（由 node 侧检查）
  const cands = [
    "C:/Users/liuyue/AppData/Roaming/Code/User/prompts",
    "C:/Users/liuyue/AppData/Roaming/Code/prompts",
  ];
  console.log("\n=== [3] promptsHome 候选路径 ===");
  for (const p of cands) console.log(`${fs.existsSync(p) ? "✅" : "❌"} ${p}`);
  c.close(); process.exit(0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
