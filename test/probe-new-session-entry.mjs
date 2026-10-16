#!/usr/bin/env node
/** 深探：找"新建会话"入口 + 输入区会话类型 picker 的真实位置。 */
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
  // 找所有含"新建"的可点元素
  const out = JSON.parse(await ev("(() => {"
    + "const res=[];"
    + "document.querySelectorAll('a,button,[role=\"button\"],.monaco-button,.action-label').forEach(el=>{"
    + "  const t=(el.textContent||'').trim(); const al=el.getAttribute('aria-label')||'';"
    + "  if(/新建|new|\\+/i.test(t)||/新建|new/i.test(al)){ const b=el.getBoundingClientRect(); if(b.width>0&&b.height>0) res.push({tag:el.tagName,cls:el.className.slice(0,50),t:t.slice(0,40),al:al.slice(0,40),x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}); }"
    + "});"
    + "return JSON.stringify(res.slice(0,40));"
    + "})()"));
  console.log("含'新建'元素:");
  for (const e of out) console.log("  ", JSON.stringify(e));
  // 输入区 DOM 结构（找 chat-input 容器）
  const dom = await ev("(() => {"
    + "const cand=['.chat-input','.chat-editor-container','.interactive-input-part','.chat-input-picker-item','.chat-mode-picker','.chat-editor','[data-testid]'];"
    + "const res={};"
    + "for(const s of cand){const n=document.querySelectorAll(s).length; if(n) res[s]=n;}"
    + "return JSON.stringify(res);"
    + "})()");
  console.log("\n已知容器计数:", dom);
  ws.close(); process.exit(0);
})();
