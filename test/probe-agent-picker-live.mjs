// probe-agent-picker-live.mjs — 定位 agent picker 的实际渲染位置与数据来源
const PORT = process.argv[2] || '9333';
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
      awaitPromise: !!opts.awaitPromise, returnByValue: true, timeout: opts.timeout || 15000 });
    if (r.__timeout) return { __timeout: true };
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  }
}
const dump = (o) => JSON.stringify(o);

(async () => {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const win = list.filter(t => t.type === 'page').find(p => /sessions/i.test(p.url));
  const c = new CDP(win.webSocketDebuggerUrl); await c.connect();
  await c.send('Runtime.enable');

  // 1) 找 "选择会话类型" 那个按钮/触发器，看它的完整 outerHTML 与附近 DOM
  const trigger = await c.eval(`(()=>{
    const els=[...document.querySelectorAll('*')].filter(el => /选择会话类型/i.test(el.getAttribute?.('aria-label')||''));
    return els.slice(0,3).map(el=>({
      tag:el.tagName, cls:(el.className||'').slice(0,120), role:el.getAttribute('role'),
      aria:el.getAttribute('aria-label'), expanded:el.getAttribute('aria-expanded'),
      text:(el.textContent||'').trim().slice(0,40),
      outerHTML:(el.outerHTML||'').slice(0,400),
      parentCls:((el.parentElement&&el.parentElement.className)||'').slice(0,120),
    }));
  })()`);
  console.log('[1] "选择会话类型" 触发器:', dump(trigger));

  // 2) 点击它，看下拉里有什么
  const clicked = await c.eval(`(()=>{
    const el=[...document.querySelectorAll('*')].find(el => /选择会话类型/i.test(el.getAttribute?.('aria-label')||''));
    if(!el) return {found:false};
    (el.closest('button')||el).click();
    return {found:true, tag:el.tagName};
  })()`);
  console.log('\n[2] 点击会话类型下拉:', dump(clicked));
  await sleep(1500);

  // 3) 枚举下拉/菜单里出现的所有选项
  const opts = await c.eval(`(()=>{
    const out=[];
    document.querySelectorAll('[role="option"],[role="menuitem"],[role="menuitemradio"],[role="listbox"] > *').forEach(el=>{
      const t=(el.textContent||'').trim().slice(0,50);
      if(t) out.push({role:el.getAttribute('role'), txt:t});
    });
    return out.slice(0,40);
  })()`);
  console.log('\n[3] 下拉选项:', dump(opts));

  // 4) 关闭下拉，检查是否 localStorage/IndexedDB 有 agent 数据
  await c.eval(`document.body.click()`);
  const store = await c.eval(`(()=>{
    const out={};
    try{ const ks=[]; for(let i=0;i<localStorage.length;i++) ks.push(localStorage.key(i)); out.localStorageKeys=ks.filter(k=>/agent|custom/i.test(k)).slice(0,30);}catch(e){out.lsErr=String(e);}
    return out;
  })()`);
  console.log('\n[4] 存储里的 agent 相关键:', dump(store));

  // 5) ★ 关键：直接抓 renderer 里的 agent 选择器组件数据（若可及）
  const probe = await c.eval(`(()=>{
    const hits=[];
    // 遍历所有元素找含 "Agent"/"模式" 且是个 chip/button 的
    document.querySelectorAll('button,[role="button"],[class*="picker"],[class*="dropdown"]').forEach(el=>{
      const t=(el.textContent||'').trim();
      if(t && t.length<30 && /Agent|模式|picker/i.test(t)) hits.push({cls:(el.className||'').slice(0,80),txt:t,aria:el.getAttribute('aria-label')});
    });
    return hits.slice(0,25);
  })()`);
  console.log('\n[5] 疑似 agent/模式 控件:', dump(probe));
})();
