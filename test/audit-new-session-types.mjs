// audit-new-session-types.mjs — 打开"新会话"选择器，枚举可选的 agent 类型（关键：DSH 是否可选）
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

  // 1) 找"新会话"按钮（侧栏），带 rect
  const btn = await c.eval(`(()=>{
    const cands=[...document.querySelectorAll('[aria-label],button,[role="button"]')];
    const hits=cands.map(e=>{const a=e.getAttribute&&e.getAttribute('aria-label')||''; const t=(e.textContent||'').trim();
      return {aria:a, text:t, rect:(()=>{const r=e.getBoundingClientRect();return [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)];})()};})
      .filter(o=>/新会话|新建会话|New Session|New Chat/i.test(o.aria+o.text));
    return hits.slice(0,6);
  })()`);
  console.log("[1] '新会话' 按钮:", dump(btn));

  // 2) 点击它
  if (Array.isArray(btn) && btn[0]) {
    const [x, y, w, h] = btn[0].rect;
    if (w > 0) { await c.mouse(x + w / 2, y + h / 2); console.log("[2] clicked at", x + w / 2, y + h / 2); }
    else console.log("[2] button not visible (w=0)");
  }
  await sleep(2500);

  // 3) 枚举浮层（agent 类型选择器）
  console.log("\n[3] overlays:", dump(await c.eval(`(()=>{
    const out=[];
    document.querySelectorAll('.monaco-list, .monaco-menu, [role="menu"], [role="listbox"], .quick-input-widget, [class*="context-view"]').forEach(o=>{
      const r=o.getBoundingClientRect(); if(r.width<=0||r.height<=0) return;
      const items=[...o.querySelectorAll('.monaco-list-row,[role="menuitem"],[role="option"],li,.action-item,.monaco-list-row *')].map(e=>(e.textContent||'').trim()).filter(Boolean);
      out.push({rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)], text:(o.innerText||'').replace(/\\n+/g,' | ').slice(0,600)});
    });
    return out.slice(0,10);
  })()`)));

  // 4) 全页搜 DSH / Copilot / Claude（agent 类型名）
  console.log("\n[4] agent type names on screen:", dump(await c.eval(`(()=>{
    const t=document.body.innerText||'';
    const names={}; for(const w of ['DSH','DeepSeek','Copilot','Claude','Codex','Bowei','自定义','Custom']) { const i=t.indexOf(w); names[w]= i<0?null:t.slice(Math.max(0,i-25),i+45).replace(/\\n/g,' '); }
    return names;
  })()`)));

  process.exit(0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
