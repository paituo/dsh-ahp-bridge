// audit-sessiontype-dropdown.mjs — 点"选择会话类型"下拉，枚举 agent 类型（DSH 是否在列）
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
const dump = o => JSON.stringify(o, null, 1);

(async () => {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const win = list.filter(t => t.type === 'page').find(p => /sessions|智能体/i.test(p.title + p.url));
  const c = new CDP(win.webSocketDebuggerUrl); await c.connect();
  await c.send('Runtime.enable');

  const r = await c.eval(`(()=>{
    const el=[...document.querySelectorAll('[aria-label]')].find(e=>/选择会话类型/.test(e.getAttribute('aria-label')||''));
    if(!el) return {notFound:true};
    const rc=el.getBoundingClientRect();
    return {found:true, label:el.getAttribute('aria-label'), rect:[Math.round(rc.x),Math.round(rc.y),Math.round(rc.width),Math.round(rc.height)]};
  })()`);
  console.log("[1] session-type selector:", dump(r));
  if (!r.found) { process.exit(1); }
  const [x, y, w, h] = r.rect;
  await c.mouse(x + w / 2, y + h / 2);
  await sleep(1500);

  console.log("\n[2] dropdown items:", dump(await c.eval(`(()=>{
    const out=[];
    document.querySelectorAll('.monaco-list-row,[role="menuitem"],[role="option"],[role="menuitemradio"],[role="menuitemcheckbox"]').forEach(e=>{
      const rc=e.getBoundingClientRect(); if(rc.width<=0||rc.height<=0) return;
      const t=(e.textContent||'').trim().replace(/\\s+/g,' ').slice(0,80); if(t) out.push(t);
    });
    return [...new Set(out)];
  })()`)));

  console.log("\n[3] full visible overlay text:", dump(await c.eval(`(()=>{
    const out=[];
    document.querySelectorAll('.monaco-list,[role="menu"],[class*="context-view"]').forEach(o=>{
      const rc=o.getBoundingClientRect(); if(rc.width<=0||rc.height<=0) return;
      out.push({rect:[Math.round(rc.x),Math.round(rc.y),Math.round(rc.width),Math.round(rc.height)], text:(o.innerText||'').replace(/\\n+/g,' | ').slice(0,500)});
    });
    return out.slice(0,6);
  })()`)));
  process.exit(0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
