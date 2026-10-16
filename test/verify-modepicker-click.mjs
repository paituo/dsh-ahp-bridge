#!/usr/bin/env node
/**
 * 精确点击 chat-mode-picker-item 内的 a.action-label[aria-haspopup=true] 并抓 dropdown。
 */
const CDP = process.argv[2] || "9333";
async function wsEval(wsUrl, expr, timeoutMs = 30000) {
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
  const W = w.webSocketDebuggerUrl;

  console.log("=== 精确点击 a.action-label[aria-label]+haspopup ===");
  console.log(JSON.stringify(await wsEval(W, `(async () => {
    const clickables = [...document.querySelectorAll('.chat-mode-picker-item a.action-label[aria-haspopup="true"], .chat-input-picker-item a.action-label[aria-haspopup="true"]')];
    const info = clickables.map(a=>({ aria:a.getAttribute('aria-label'), expanded:a.getAttribute('aria-expanded') }));
    // agent picker = aria-label 恰为 "Agent"
    const agent = clickables.find(a => /^Agent$/i.test(a.getAttribute('aria-label')||''));
    if (!agent) return { err:'no agent picker', clickables: info };
    agent.click();
    await new Promise(r=>setTimeout(r,1800));
    const menus = [...document.querySelectorAll('.context-view, .monaco-menu, [role="menu"], [role="listbox"], .quick-input-widget')]
      .filter(m => !/chat-response-selection/.test(m.className||''));
    const items = [];
    for (const m of menus) for (const li of m.querySelectorAll('[role="menuitem"],[role="option"],.monaco-list-row,.action-item,.monaco-list-row .label,.monaco-list-row span')) {
      const tx=(li.textContent||'').trim(); if(tx&&tx.length<80) items.push(tx);
    }
    return { clickables: info, menuCount: menus.length, items: [...new Set(items)].slice(0,40),
             menuText: menus.map(m=>(m.textContent||'').trim().slice(0,400)).filter(Boolean).slice(0,3) };
  })()`), null, 2));
  process.exit(0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
