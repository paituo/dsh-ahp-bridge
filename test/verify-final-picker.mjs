// verify-final-picker.mjs — 在 DSH 会话中验证 agent picker 是否出现 preset
const PORT = process.argv[2] || '9333';
const BASE = `http://127.0.0.1:${PORT}`;
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

(async () => {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const win = list.filter(t => t.type === 'page').find(p => /sessions/i.test(p.url));
  const c = new CDP(win.webSocketDebuggerUrl); await c.connect();
  await c.send('Runtime.enable');

  // 1) 点"新会话"
  const r1 = await c.eval(`(()=>{
    const btns=[...document.querySelectorAll('a,button,[role="button"]')];
    const t=btns.find(el=>/新会话|^新/.test((el.textContent||'').trim()) && (el.getAttribute('aria-label')||'').includes('新会话'));
    if(t){t.click(); return {clicked:true, aria:t.getAttribute('aria-label')};}
    return {clicked:false, sample:btns.map(b=>b.getAttribute('aria-label')).filter(Boolean).slice(0,10)};
  })()`);
  console.log('[1] 点击新会话:', dump(r1));
  await sleep(3000);

  // 2) 检查新会话下 agent picker 的 aria 与状态
  const r2 = await c.eval(`(()=>{
    const el=document.querySelector('[aria-label^="选择模式"],[aria-label^="选取 Agent"]');
    if(!el) return {found:false, all:[...document.querySelectorAll('[aria-label]')].map(e=>e.getAttribute('aria-label')).filter(x=>/模式|Agent/i.test(x))};
    return {found:true, aria:el.getAttribute('aria-label'), cls:(el.className||'').slice(0,90), text:(el.textContent||'').trim()};
  })()`);
  console.log('[2] agent picker:', dump(r2));

  // 3) 点开它
  const r3 = await c.eval(`(()=>{
    const el=document.querySelector('[aria-label^="选择模式"],[aria-label^="选取 Agent"]');
    if(!el) return {found:false};
    el.click(); return {found:true};
  })()`);
  console.log('[3] 点开:', dump(r3));
  await sleep(2200);

  // 4) 抓所有可见下拉项
  const r4 = await c.eval(`(()=>{
    const out=[];
    document.querySelectorAll('[role="option"],[role="menuitemradio"],[role="menuitem"]').forEach(el=>{
      if(el.offsetParent!==null) out.push({role:el.getAttribute('role'), txt:(el.textContent||'').trim().slice(0,60)});
    });
    return out;
  })()`);
  console.log('[4] ★★ 下拉项:', dump(r4));

  // 5) preset 探针
  const r5 = await c.eval(`(()=>{const t=document.body.innerText;return {'标准模式':t.includes('标准模式'),'PTC':t.includes('PTC'),'极简':t.includes('极简'),'创作者':t.includes('创作者'),'梁神':t.includes('梁神')};})()`);
  console.log('[5] preset 探针:', dump(r5));

  await c.eval(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
})();
