#!/usr/bin/env node
/** 探测 Agents 窗口当前状态：会话类型 / 输入区全部 picker / 是否已有 DSH 会话。 */
const PORT = process.argv[2] || "9333";
async function main() {
  const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
  const pages = list.filter((p) => p.type === "page");
  const pg = pages.find((p) => /^Agent/i.test(p.title || "")) || pages[0];
  console.log("pages:", pages.map((p) => p.title).join(" | "));
  console.log("target:", pg.title, pg.url.slice(0, 80));

  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data.toString()); if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable");
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };

  const expr = "(() => {"
    + "const picks = [...document.querySelectorAll('a.action-label[aria-haspopup=\"true\"]')].map(a => ({ label: a.getAttribute('aria-label')||'', text:(a.textContent||'').trim().slice(0,30) }));"
    + "const rows = [...document.querySelectorAll('.monaco-list-row')].map(r => (r.textContent||'').trim().slice(0,60)).filter(Boolean).slice(0,25);"
    + "const inputs = [...document.querySelectorAll('.chat-input-picker-item, .chat-mode-picker-item')].map(e => (e.textContent||'').trim().slice(0,40));"
    + "const bodyText = (document.body.innerText||'').slice(0, 1200);"
    + "return JSON.stringify({ picks, rows, inputs, bodyText });"
    + "})()";
  const out = JSON.parse(await ev(expr));
  console.log("\n输入区 pickers:", JSON.stringify(out.picks, null, 1));
  console.log("\nmonaco 列表行(前25):", JSON.stringify(out.rows, null, 1));
  console.log("\nchat picker 元素:", JSON.stringify(out.inputs, null, 1));
  console.log("\n页面文本前 1200 字:\n" + out.bodyText);
  ws.close();
  process.exit(0);
}
main();
