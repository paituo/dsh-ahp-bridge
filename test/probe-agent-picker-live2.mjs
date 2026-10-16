// probe-agent-picker-live2.mjs — 展开 agent picker（"选择模式，Agent"）枚举其选项
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

  // 1) 找 agent picker 触发器（aria="选择模式，Agent"）完整结构
  const trig = await c.eval(`(()=>{
    const el=[...document.querySelectorAll('*')].find(el => /^选择模式/.test(el.getAttribute?.('aria-label')||''));
    if(!el) return {found:false, sample:[...document.querySelectorAll('[aria-label*="模式"]')].map(e=>e.getAttribute('aria-label')).slice(0,5)};
    return {found:true, tag:el.tagName, cls:(el.className||'').slice(0,150), aria:el.getAttribute('aria-label'),
      expanded:el.getAttribute('aria-expanded'), haspopup:el.getAttribute('aria-haspopup'),
      outerHTML:(el.outerHTML||'').slice(0,500),
      parentCls:((el.parentElement&&el.parentElement.className)||'').slice(0,150)};
  })()`);
  console.log('[1] agent picker 触发器:', dump(trig));

  // 2) 点击展开
  const click = await c.eval(`(()=>{
    const el=[...document.querySelectorAll('*')].find(el => /^选择模式/.test(el.getAttribute?.('aria-label')||''));
    if(!el) return {found:false};
    (el.closest('a,button,[role="button"]')||el).click();
    return {found:true};
  })()`);
  console.log('\n[2] 点击展开:', dump(click));
  await sleep(1800);

  // 3) 枚举下拉内容（含深层文本）
  const dd = await c.eval(`(()=>{
    const out={options:[],allText:''};
    document.querySelectorAll('[role="listbox"],[role="menu"],[class*="monaco-list"]').forEach(el=>{
      if(!el.offsetParent) return;
      el.querySelectorAll('[role="option"],[role="menuitem"],.monaco-list-row').forEach(o=>{
        const t=(o.textContent||'').trim().slice(0,70);
        if(t) out.options.push(t);
      });
    });
    return out;
  })()`);
  console.log('\n[3] 展开后选项:', dump(dd));

  // 4) 全页文本复查 preset
  const txt = await c.eval(`document.body.innerText`);
  const t = typeof txt === 'string' ? txt : '';
  console.log('\n[4] preset 探针（展开态）:');
  for (const k of ['标准模式','PTC','极简','创作者','梁神','自定义 Agent','Custom']) {
    console.log(`   ${t.includes(k) ? '✅' : '❌'} ${k}`);
  }

  // 5) 关闭
  await c.eval(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
})();
