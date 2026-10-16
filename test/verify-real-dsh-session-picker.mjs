// verify-real-dsh-session-picker.mjs — 精确打开真实 DSH 会话并验证 picker
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
const snap = (c, label) => c.eval(`(()=>{
  const t=document.body.innerText;
  const ag=[...document.querySelectorAll('[aria-label^="选择模式"],[aria-label^="选取 Agent"]')][0];
  const ty=[...document.querySelectorAll('[aria-label^="选择会话类型"]')][0];
  return {${label}:1,
    agent: ag ? ag.getAttribute('aria-label') : null,
    type: ty ? ty.getAttribute('aria-label') : null,
    preset:{'标准模式':t.includes('标准模式'),'PTC':t.includes('PTC'),'极简':t.includes('极简'),'创作者':t.includes('创作者'),'梁神':t.includes('梁神')}};
})()`);

(async () => {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const win = list.filter(t => t.type === 'page').find(p => /sessions/i.test(p.url));
  const c = new CDP(win.webSocketDebuggerUrl); await c.connect();
  await c.send('Runtime.enable');

  console.log('[0] 初始:', dump(await snap(c, 'init')));

  // 用 Ctrl+N 新建会话 → 发送一条消息 → 使其成为真实会话
  // 但更稳的是：直接在侧栏里按 provider 分组找。先看侧栏结构。
  const structure = await c.eval(`(()=>{
    // 找侧栏会话分组标题与其下会话项
    const out=[];
    document.querySelectorAll('[role="listbox"],[class*="session"],[class*="chat-list"]').forEach(el=>{
      if(el.offsetParent===null) return;
      const items=[...el.querySelectorAll('[role="option"],li,button')].map(x=>(x.textContent||'').trim().slice(0,50)).filter(Boolean);
      if(items.length) out.push({cls:(el.className||'').slice(0,60), n:items.length, items:items.slice(0,8)});
    });
    return out.slice(0,8);
  })()`);
  console.log('[1] 侧栏结构:', dump(structure));

  // 点第一个看起来像会话的项（跳过"新会话"按钮）
  const pick = await c.eval(`(()=>{
    const cands=[...document.querySelectorAll('[role="option"]')].filter(el=>el.offsetParent!==null);
    if(!cands.length) return {found:false};
    // 选最长文本（通常是会话项，含标题+时间）
    const best=cands.sort((a,b)=>(b.textContent||'').length-(a.textContent||'').length)[0];
    best.click();
    return {found:true, txt:(best.textContent||'').trim().slice(0,70)};
  })()`);
  console.log('[2] 点击会话项:', dump(pick));
  await sleep(4000);

  console.log('[3] 点开后:', dump(await snap(c, 'after')));

  // 展开 agent picker
  const ag = await c.eval(`(()=>{
    const el=document.querySelector('[aria-label^="选择模式"],[aria-label^="选取 Agent"]');
    if(!el) return {found:false};
    (el.closest('a,button')||el).click();
    return {found:true, aria:el.getAttribute('aria-label')};
  })()`);
  console.log('[4] 展开 agent picker:', dump(ag));
  await sleep(2500);

  const opts = await c.eval(`(()=>{
    const out=[];
    document.querySelectorAll('[role="option"],[role="menuitemradio"],[role="menuitem"]').forEach(el=>{
      if(el.offsetParent!==null) out.push((el.textContent||'').trim().slice(0,60));
    });
    return [...new Set(out)];
  })()`);
  console.log('[5] ★★ agent 下拉项:', dump(opts));
  console.log('[6] ★★ preset 探针:', dump((await snap(c, 'final')).preset));

  await c.eval(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
})();
