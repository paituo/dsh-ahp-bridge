// verify-picker-live-trace.mjs — 点开 agent picker，抓取真实选项，并对比桥日志是否新增 agent/list
const PORT = process.argv[2] || '9333';
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = process.argv[3] || '';
const fs = await import('node:fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class CDP {
  constructor(u) { this.u = u; this.id = 0; this.pending = new Map(); }
  connect() { return new Promise((res, rej) => { const ws = new WebSocket(this.u); this.ws = ws;
    ws.onopen = () => res(this); ws.onerror = e => rej(new Error('ws ' + (e.message || e)));
    ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } }; }); }
  send(method, params = {}, timeout = 30000) { const id = ++this.id;
    return new Promise(resolve => { this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); resolve({ __timeout: true }); } }, timeout); }); }
  async eval(expr, opts = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(()=>{try{return (${expr});}catch(e){return {__err:String(e&&e.message||e)};}})()`,
      awaitPromise: false, returnByValue: true, timeout: opts.timeout || 20000 });
    if (r.__timeout) return { __timeout: true };
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  }
}
const dump = (o) => JSON.stringify(o);
const countAgentList = () => { try { return (fs.readFileSync(LOG, 'utf8').match(/agent\/list:/g) || []).length; } catch { return -1; } };

(async () => {
  const before = countAgentList();
  console.log('[0] 桥日志 agent/list 次数(前):', before);

  const list = await (await fetch(`${BASE}/json/list`)).json();
  const win = list.filter(t => t.type === 'page').find(p => /sessions/i.test(p.url));
  const c = new CDP(win.webSocketDebuggerUrl); await c.connect();
  await c.send('Runtime.enable');

  // 1) 找 agent picker 触发器并点击
  const r1 = await c.eval(`(()=>{
    const el=document.querySelector('.chat-agent-picker-item a, [class*="agent-picker"] a, [aria-label^="选择模式"]');
    if(!el) return {found:false, all:[...document.querySelectorAll('[aria-label]')].map(e=>e.getAttribute('aria-label')).filter(x=>/模式|agent/i.test(x)).slice(0,5)};
    el.click();
    return {found:true, aria:el.getAttribute('aria-label'), cls:(el.className||'').slice(0,80)};
  })()`);
  console.log('[1] 点击 agent picker:', dump(r1));
  await sleep(2000);

  // 2) 枚举所有可见下拉项（含 monaco-list action widget）
  const r2 = await c.eval(`(()=>{
    const out=[];
    // 通用：所有可见的 role=option/menuitem，以及 monaco action widget 行
    document.querySelectorAll('[role="option"],[role="menuitem"],[role="menuitemradio"]').forEach(el=>{
      if(el.offsetParent!==null) out.push({src:'role', txt:(el.textContent||'').trim().slice(0,60)});
    });
    document.querySelectorAll('.monaco-list-row, .action-widget .monaco-list-row').forEach(el=>{
      if(el.offsetParent!==null) out.push({src:'monaco', txt:(el.textContent||'').trim().slice(0,60)});
    });
    // 也抓 .context-view / .monaco-menu 容器内容
    document.querySelectorAll('.context-view, .monaco-menu, .action-widget').forEach(el=>{
      if(el.offsetParent!==null) out.push({src:'ctx', txt:(el.textContent||'').trim().slice(0,120)});
    });
    return out.slice(0,25);
  })()`);
  console.log('[2] 下拉可见项:', dump(r2));

  const after = countAgentList();
  console.log('\n[3] 桥日志 agent/list 次数(后):', after, ' 增量:', after - before);
  const txt = await c.eval(`document.body.innerText`);
  const t = typeof txt === 'string' ? txt : '';
  console.log('[4] preset 探针:', dump({ '标准模式': t.includes('标准模式'), 'PTC': t.includes('PTC'), '极简': t.includes('极简'), '创作者': t.includes('创作者'), '梁神': t.includes('梁神') }));

  await c.eval(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
})();
