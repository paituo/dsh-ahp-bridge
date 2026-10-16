#!/usr/bin/env node
/**
 * 用真实鼠标事件序列触发 VS Code 自定义下拉（monaco-dropdown 监听 mousedown）。
 * 并同时用 Input.dispatchMouseEvent 走真实输入通道。
 */
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

  // 1) 拿到 agent picker 的屏幕坐标
  const pos = await cdpCall(W, "Runtime.evaluate", {
    expression: `(() => {
      const a = [...document.querySelectorAll('.chat-input-picker-item a.action-label[aria-haspopup="true"]')]
        .find(x => /^Agent$/i.test(x.getAttribute('aria-label')||''));
      if (!a) return null;
      const r = a.getBoundingClientRect();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), w: r.width, h: r.height };
    })()`, returnByValue: true,
  });
  const p = pos?.result?.value;
  console.log("=== agent picker 坐标 ===", JSON.stringify(p));
  if (!p) { console.log("❌ 未找到"); process.exit(1); }

  // 2) 用真实鼠标事件点击
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdpCall(W, "Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1 });
  }
  await sleep(1800);

  // 3) 抓 dropdown
  const r = await cdpCall(W, "Runtime.evaluate", {
    expression: `(() => {
      const overlays = [...document.querySelectorAll('.context-view, .monaco-menu, [role="menu"], [role="listbox"], .quick-input-widget')]
        .filter(m => !/chat-response-selection/.test(m.className||''));
      const items = [];
      for (const m of overlays) for (const li of m.querySelectorAll('[role="menuitem"],[role="option"],.monaco-list-row,.action-item span,.monaco-list-row span')) {
        const tx=(li.textContent||'').trim(); if(tx&&tx.length<100) items.push(tx);
      }
      return { count: overlays.length, items: [...new Set(items)].slice(0,40),
               texts: overlays.map(m=>(m.textContent||'').trim().slice(0,600)).filter(Boolean).slice(0,3) };
    })()`, returnByValue: true,
  });
  console.log("\n=== 真实鼠标点击后的下拉 ===");
  console.log(JSON.stringify(r?.result?.value, null, 2));
  process.exit(0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
