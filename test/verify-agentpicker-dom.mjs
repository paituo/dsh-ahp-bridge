#!/usr/bin/env node
/**
 * 判决性验证：renderer 侧是否把 agenthost-dsh 识别为 sessionType。
 *
 * 思路：VS Code 的 DI 容器在 window 上不易访问，但我们可以：
 *  1) dump agent picker item 的完整 DOM 结构（找到真正的下拉触发器）
 *  2) 点击真正触发器，抓 dropdown
 *  3) 检查 DOM 里是否有 "standard/标准模式" 等 preset 文案
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

  console.log("=== [1] \"Agent\" picker 的祖先链与结构 ===");
  console.log(JSON.stringify(await wsEval(W, `(() => {
    const lbl = [...document.querySelectorAll('.chat-input-picker-label')].find(e => /^Agent$/i.test((e.textContent||'').trim()));
    if (!lbl) return { err: 'no label' };
    const chain = [];
    let cur = lbl;
    for (let i=0;i<6 && cur;i++){
      chain.push({ tag: cur.tagName, cls: (cur.className||'').toString().slice(0,90), aria: cur.getAttribute('aria-label'), hapopup: cur.getAttribute('aria-haspopup'), role: cur.getAttribute('role') });
      cur = cur.parentElement;
    }
    // 找兄弟/父里的下拉触发器
    const item = lbl.closest('.chat-input-picker-item');
    return { chain, itemHTML: item ? item.outerHTML.slice(0,800) : null };
  })()`), null, 2));

  console.log("\n=== [2] 点击 picker 容器（非 label）后抓 dropdown ===");
  console.log(JSON.stringify(await wsEval(W, `(async () => {
    const lbl = [...document.querySelectorAll('.chat-input-picker-label')].find(e => /^Agent$/i.test((e.textContent||'').trim()));
    const item = lbl && lbl.closest('.chat-input-picker-item');
    if (!item) return { err: 'no item' };
    // 点 item 内的 button/a
    const btn = item.querySelector('button,a,[role=button]') || item;
    btn.click();
    await new Promise(r=>setTimeout(r,1600));
    // 抓所有新出现的浮层
    const overlays = [...document.querySelectorAll('.monaco-editor .overflow-guard, .context-view, .quick-input-widget, .monaco-menu, [role="listbox"], [role="menu"]')];
    const dump = overlays.map(o => ({
      cls: (o.className||'').toString().slice(0,60),
      text: (o.textContent||'').trim().slice(0, 300)
    })).filter(x=>x.text);
    return { clicked: true, overlays: dump.slice(0,10) };
  })()`), null, 2));

  process.exit(0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
