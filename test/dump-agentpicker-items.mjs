#!/usr/bin/env node
/** 展开 agent picker 并 dump 每一项的完整结构（含 sessionTypes/来源信息）。 */
const CDP = process.argv[2] || "9333";
async function cdpCall(wsUrl, method, params, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pend = new Map();
    const timer = setTimeout(() => { try { ws.close(); } catch {} ; resolve({ __timeout: true }); }, timeoutMs);
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: ++id, method: "Runtime.enable" }));
      const myId = ++id; pend.set(myId, (v) => { clearTimeout(timer); resolve(v); ws.close(); });
      ws.send(JSON.stringify({ id: myId, method, params }));
    };
    ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) pend.get(m.id)(m.result ?? m); } catch {} };
    ws.onerror = () => { clearTimeout(timer); resolve({ __err: "ws" }); };
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const w = list.find((x) => /sessions/i.test(x.url || ""));
  const W = w.webSocketDebuggerUrl;
  const pos = await cdpCall(W, "Runtime.evaluate", {
    expression: `(() => { const a=[...document.querySelectorAll('.chat-input-picker-item a.action-label[aria-haspopup="true"]')].find(x=>/^Agent$/i.test(x.getAttribute('aria-label')||'')); if(!a)return null; const r=a.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()`,
    returnByValue: true,
  });
  const p = pos?.result?.value;
  if (!p) { console.log("no picker"); process.exit(1); }
  for (const type of ["mousePressed", "mouseReleased"]) await cdpCall(W, "Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1 });
  await sleep(1500);
  const r = await cdpCall(W, "Runtime.evaluate", {
    expression: `(() => {
      const menus = [...document.querySelectorAll('.monaco-list')].filter(m=>/Agent|Ask|Plan/.test(m.textContent||''));
      const out = [];
      for (const m of menus) {
        for (const row of m.querySelectorAll('.monaco-list-row')) {
          out.push({
            text: (row.textContent||'').trim().slice(0,80),
            aria: row.getAttribute('aria-label'),
            idx: row.getAttribute('data-index'),
            title: row.getAttribute('title'),
          });
        }
      }
      return out;
    })()`, returnByValue: true,
  });
  console.log("=== agent picker 每一项 ===");
  console.log(JSON.stringify(r?.result?.value, null, 2));
  process.exit(0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
