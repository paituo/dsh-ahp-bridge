// verify-dsh-session-picker.mjs — 新建 DSH 会话后，检查 agent picker 是否拿到 preset
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

  // 1) 当前会话类型 picker 的值
  const cur = await c.eval(`(()=>{
    const el=[...document.querySelectorAll('[aria-label^="选择会话类型"]')][0];
    if(!el) return {found:false};
    return {found:true, label:el.getAttribute('aria-label'), text:(el.textContent||'').trim()};
  })()`);
  console.log('[1] 当前会话类型:', dump(cur));

  // 2) 展开 session type dropdown 并选 DSH
  const open = await c.eval(`(()=>{
    const el=[...document.querySelectorAll('[aria-label^="选择会话类型"]')][0];
    if(!el) return {found:false};
    (el.closest('a,button')||el).click();
    return {found:true};
  })()`);
  console.log('[2] 展开会话类型:', dump(open));
  await sleep(1500);

  const opts = await c.eval(`(()=>{
    const out=[];
    document.querySelectorAll('[role="option"]').forEach(el=>{
      if(el.offsetParent) out.push((el.textContent||'').trim().slice(0,50));
    });
    return out;
  })()`);
  console.log('[3] 会话类型选项:', dump(opts));

  // 3) 点 DSH 选项
  const pick = await c.eval(`(()=>{
    const el=[...document.querySelectorAll('[role="option"]')].find(el=>/^DSH/.test((el.textContent||'').trim()));
    if(!el) return {found:false};
    el.click(); return {found:true, txt:(el.textContent||'').trim().slice(0,40)};
  })()`);
  console.log('[4] 选中 DSH:', dump(pick));
  await sleep(2500);

  // 4) 检查 agent picker 现在的内容
  const picker = await c.eval(`(()=>{
    const el=document.querySelector('.chat-agent-picker-item, [class*="agent-picker"]');
    if(!el) return {found:false};
    const label=el.querySelector('.sessions-chat-dropdown-label');
    return {found:true,
      label: label?(label.textContent||'').trim():null,
      aria: (el.querySelector('[aria-label]')||{}).getAttribute?.(el.querySelector('[aria-label]').getAttribute('aria-label')):null,
      haspopup: (el.querySelector('a')||{}).getAttribute?.('aria-haspopup'),
      outer:(el.outerHTML||'').slice(0,500)};
  })()`);
  console.log('\n[5] ★ agent picker 现状:', dump(picker));

  // 5) 点击 agent picker 看是否展开
  const clickAgent = await c.eval(`(()=>{
    const el=document.querySelector('.chat-agent-picker-item a, [class*="agent-picker"] a');
    if(!el) return {found:false};
    el.click(); return {found:true, aria:el.getAttribute('aria-label')};
  })()`);
  console.log('[6] 点击 agent picker:', dump(clickAgent));
  await sleep(1500);

  const agentOpts = await c.eval(`(()=>{
    const out=[]; 
    document.querySelectorAll('[role="option"],[role="menuitem"],[role="menuitemradio"]').forEach(el=>{
      if(el.offsetParent) out.push((el.textContent||'').trim().slice(0,60));
    });
    const txt=document.body.innerText;
    return {options:out.slice(0,30),
      presetProbe:{'标准模式':txt.includes('标准模式'),'PTC':txt.includes('PTC'),'极简':txt.includes('极简'),'创作者':txt.includes('创作者'),'梁神':txt.includes('梁神')}};
  })()`);
  console.log('\n[7] ★★ agent 选项:', dump(agentOpts));
})();
