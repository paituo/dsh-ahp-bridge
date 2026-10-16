#!/usr/bin/env node
/**
 * 精确探测：在已切到 DSH 的会话里，定位 agent picker 的准确坐标并展开，
 * dump 下拉内容（用更宽的容器选择器 + 元素文本匹配）。
 */
const PORT = process.argv[2] || "9333";
function connect(wsUrl) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pend = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data.toString()); if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    ws.onopen = () => resolve({ ws, send: (m, p) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); }) });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
  const pg = list.filter((p) => p.type === "page").find((p) => /^Agent/i.test(p.title || ""));
  const { ws, send } = await connect(pg.webSocketDebuggerUrl);
  await send("Runtime.enable");
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };
  const mouse = async (type, x, y, cc = 0) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: cc, buttons: type === "mousePressed" ? 1 : 0 });
  const clickAt = async (x, y) => { await mouse("mouseMoved", x, y); await mouse("mousePressed", x, y, 1); await mouse("mouseReleased", x, y, 1); };

  // 列出输入区内所有 action-label（带上祖先类名，便于判定归属）
  const info = JSON.parse(await ev("(() => {"
    + "const out=[];"
    + "document.querySelectorAll('.interactive-input-part a.action-label, .chat-editor-container a.action-label, .interactive-input-part [aria-haspopup]').forEach(el=>{"
    + "  const b=el.getBoundingClientRect(); if(b.width<=0)return;"
    + "  let anc=el.parentElement, chain=[];"
    + "  for(let i=0;i<5&&anc;i++){ chain.push(anc.className&&anc.className.slice?String(anc.className).slice(0,40):''); anc=anc.parentElement; }"
    + "  out.push({al:el.getAttribute('aria-label')||'', t:(el.textContent||'').trim().slice(0,30), cls:String(el.className).slice(0,70), x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2), chain});"
    + "});"
    + "return JSON.stringify(out);"
    + "})()"));
  console.log("输入区 action-label 全表:");
  for (const e of info) console.log("  ", JSON.stringify({ al: e.al, t: e.t, cls: e.cls, x: e.x, y: e.y }));
  ws.close(); process.exit(0);
})();
