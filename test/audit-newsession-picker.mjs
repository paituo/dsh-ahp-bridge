// audit-newsession-picker.mjs — 点侧栏 "New" → 展开 agent 类型选择器 → 枚举（DSH 是否可选）
const PORT = process.argv[2] || '9333';
const BASE = `http://127.0.0.1:${PORT}`;
class CDP {
  constructor(u) { this.u = u; this.id = 0; this.pending = new Map(); }
  connect() { return new Promise((res, rej) => { const ws = new WebSocket(this.u); this.ws = ws;
    ws.onopen = () => res(this); ws.onerror = e => rej(new Error('ws ' + (e.message || e)));
    ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } }; }); }
  send(method, params = {}, timeout = 25000) { const id = ++this.id;
    return new Promise(resolve => { this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); resolve({ __timeout: true }); } }, timeout); }); }
  async eval(expr, opts = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(()=>{try{return (${expr});}catch(e){return {__err:String(e&&e.message||e)};}})()`,
      awaitPromise: !!opts.awaitPromise, returnByValue: true, timeout: (opts.timeout || 15000) });
    if (r.__timeout) return { __timeout: true };
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  }
  async mouse(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dump = o => JSON.stringify(o);

(async () => {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const win = list.filter(t => t.type === 'page').find(p => /sessions|智能体/i.test(p.title + p.url));
  const c = new CDP(win.webSocketDebuggerUrl); await c.connect();
  await c.send('Runtime.enable');

  // 找侧栏会话列表头部的 "New"（"新" 或 "New"），排除聊天内容里的词
  const hits = await c.eval(`(()=>{
    const out=[];
    document.querySelectorAll('[aria-label],[role="button"],.monaco-list-row,.action-label,[class*="new-session"],[class*="newSession"]').forEach(e=>{
      const a=e.getAttribute&&e.getAttribute('aria-label')||''; const t=(e.textContent||'').trim();
      if(!/^(新|New)$/.test(t) && !/新会话|新建会话|New Session|New Chat/i.test(a)) return;
      const r=e.getBoundingClientRect(); if(r.width<=0) return;
      out.push({aria:a.slice(0,50), text:t.slice(0,20), rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]});
    });
    return out.slice(0,8);
  })()`);
  console.log("[1] New 候选:", dump(hits));

  for (const h of (Array.isArray(hits) ? hits : [])) {
    const [x, y, w, hh] = h.rect;
    await c.mouse(x + w / 2, y + hh / 2);
    console.log("[2] clicked", h.text, "@", x + w / 2, y + hh / 2);
    await sleep(2000);
    const ov = await c.eval(`(()=>{
      const out=[];
      document.querySelectorAll('.monaco-list, [role="menu"], [role="listbox"], .quick-input-widget, [class*="context-view"], [class*="picker"]').forEach(o=>{
        const r=o.getBoundingClientRect(); if(r.width<=0||r.height<=0) return;
        const items=[...o.querySelectorAll('.monaco-list-row,[role="menuitem"],[role="option"]')].map(e=>(e.textContent||'').trim().slice(0,60)).filter(Boolean);
        if(items.length) out.push({rect:[Math.round(r.x),Math.round(r.y)], items:items.slice(0,25)});
      });
      return out;
    })()`);
    console.log("[3] 浮层枚举:", dump(ov));
    // 检查是否出现 agent 类型名
    const names = await c.eval(`(()=>{const t=document.body.innerText||'';const o={};for(const w of ['DSH','DeepSeek Harness','Copilot','Claude','Codex','自定义'])o[w]=t.includes(w);return o;})()`);
    console.log("[4] 类型名出现:", dump(names));
    await sleep(300);
  }
  process.exit(0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
