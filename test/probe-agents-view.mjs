#!/usr/bin/env node
/** 探测 Agents 窗口当前视图，并找到返回会话输入框的路径。 */
const CDP = process.argv[2] || "9333";
async function wsEval(wsUrl, expr, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pend = new Map();
    const timer = setTimeout(() => { try { ws.close(); } catch {} ; resolve({ __timeout: true }); }, timeoutMs);
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: ++id, method: "Runtime.enable" }));
      const myId = ++id; pend.set(myId, (v) => { clearTimeout(timer); resolve(v); ws.close(); });
      ws.send(JSON.stringify({ id: myId, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
    };
    ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) pend.get(m.id)(m.result?.result?.value ?? m.result); } catch {} };
    ws.onerror = () => { clearTimeout(timer); resolve({ __err: "ws" }); };
  });
}
(async () => {
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const w = list.find((x) => /sessions/i.test(x.url || ""));
  if (!w) { console.log("no agents window"); process.exit(1); }
  const r = await wsEval(w.webSocketDebuggerUrl, `(() => {
    const out = {};
    out.title = document.title;
    out.bodyLen = document.body.innerText.length;
    out.textHead = document.body.innerText.replace(/\\n+/g,' | ').slice(0, 700);
    out.arials = [...document.querySelectorAll('[aria-label]')].map(e=>(e.getAttribute('aria-label')||'').slice(0,60)).filter(Boolean).slice(0, 30);
    out.classesWithPicker = [...new Set([...document.querySelectorAll('[class*="picker"]')].map(e=>e.className.split(' ')[0]))].slice(0,20);
    out.hasTextarea = !!document.querySelector('textarea, [contenteditable="true"]');
    return out;
  })()`);
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
