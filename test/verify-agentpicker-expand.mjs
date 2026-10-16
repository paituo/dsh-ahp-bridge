#!/usr/bin/env node
/**
 * 在当前会话视图里，精确展开 agent picker（chat-input-picker-label 中文本为 "Agent" 的那个）。
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

  // 1) 列出所有 chat-input-picker 项
  console.log("=== [1] 输入区 picker 清单 ===");
  console.log(JSON.stringify(await wsEval(W, `(() => {
    return [...document.querySelectorAll('.chat-input-picker-label, .chat-input-picker-split-button, [class*="picker-container"] *')]
      .filter(e => e.children.length === 0)
      .map(e => ({ tx: (e.textContent||'').trim().slice(0,40), cls: e.className.slice(0,60), tag: e.tagName }))
      .filter(x => x.tx).slice(0, 25);
  })()`), null, 2));

  // 2) 找到 agent picker 的确切元素并展开
  console.log("\n=== [2] 尝试展开 agent picker ===");
  console.log(JSON.stringify(await wsEval(W, `(async () => {
    // agent picker 的特征：chat-input-picker-item 类，文本为 "Agent"
    const cands = [...document.querySelectorAll('.chat-input-picker-item, [class*="chat-agent-picker"], .chat-input-picker-label')];
    const target = cands.find(e => /^Agent$/i.test((e.textContent||'').trim()))
                || cands.find(e => /Agent/i.test(e.getAttribute('aria-label')||''));
    if (!target) return { err: 'not found', cands: cands.map(e=>({t:(e.textContent||'').trim().slice(0,30),c:e.className.slice(0,50)})).slice(0,12) };
    const clickable = target.closest('[aria-haspopup]') || target.closest('a,button,[role=button]') || target;
    const before = { tx: (target.textContent||'').trim(), haspopup: clickable.getAttribute('aria-haspopup'), aria: clickable.getAttribute('aria-label') };
    clickable.click();
    await new Promise(r=>setTimeout(r,1800));
    const menus = [...document.querySelectorAll('.context-view, .monaco-menu, [role="menu"], [role="listbox"], .quick-input-widget')];
    const items = [];
    for (const m of menus) for (const li of m.querySelectorAll('[role="menuitem"],[role="option"],.monaco-list-row,.action-item,.monaco-list-row .label')) {
      const tx=(li.textContent||'').trim(); if(tx&&tx.length<80) items.push(tx);
    }
    return { before, menuCount: menus.length, items: [...new Set(items)].slice(0,40) };
  })()`), null, 2));

  process.exit(0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
