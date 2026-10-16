// verify-open-real-session.mjs — 打开真实 agenthost-dsh 会话，验证 agent picker 出现 preset
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
const probe = (c) => c.eval(`(()=>{const t=document.body.innerText;return {'标准模式':t.includes('标准模式'),'PTC':t.includes('PTC'),'极简':t.includes('极简'),'创作者':t.includes('创作者'),'梁神':t.includes('梁神')};})()`);

(async () => {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const win = list.filter(t => t.type === 'page').find(p => /sessions/i.test(p.url));
  const c = new CDP(win.webSocketDebuggerUrl); await c.connect();
  await c.send('Runtime.enable');

  // 1) 列出侧栏所有会话项，找出 DSH 相关
  const sessions = await c.eval(`(()=>{
    const out=[];
    document.querySelectorAll('[role="option"],[class*="session-item"],[class*="chat-item"],li').forEach(el=>{
      const t=(el.textContent||'').trim();
      if(t && t.length<90 && /[\u4e00-\u9fa5a-zA-Z0-9]/.test(t)) out.push(t.slice(0,80));
    });
    return [...new Set(out)].slice(0,40);
  })()`);
  console.log('[1] 侧栏会话项:', dump(sessions));

  // 2) 找到并点击一个 DSH 会话（名字含"链路已验证"/"协议审计"/"CDP链路"等测试会话）
  const clicked = await c.eval(`(()=>{
    const cands=[...document.querySelectorAll('[role="option"],[class*="session-item"],[class*="chat-item"],li')];
    const t=cands.find(el=>/链路已验证|协议审计|CDP链路|自定义智能体正常|请只回复/.test((el.textContent||'')));
    if(!t) return {found:false};
    (t.closest('[role="option"]')||t).click();
    return {found:true, txt:(t.textContent||'').trim().slice(0,60)};
  })()`);
  console.log('[2] 点击会话:', dump(clicked));
  await sleep(3500);

  // 3) 检查会话类型 picker 当前值
  const st = await c.eval(`(()=>{
    const el=[...document.querySelectorAll('[aria-label^="选择会话类型"]')][0];
    return el ? {aria:el.getAttribute('aria-label')} : {found:false};
  })()`);
  console.log('[3] 会话类型:', dump(st));

  // 4) ★ 展开 agent picker
  const ag = await c.eval(`(()=>{
    const el=document.querySelector('[aria-label^="选择模式"],[aria-label^="选取 Agent"]');
    if(!el) return {found:false};
    (el.closest('a,button')||el).click();
    return {found:true, aria:el.getAttribute('aria-label'), text:(el.textContent||'').trim()};
  })()`);
  console.log('[4] ★ 点击 agent picker:', dump(ag));
  await sleep(2500);

  const opts = await c.eval(`(()=>{
    const out=[];
    document.querySelectorAll('[role="option"],[role="menuitemradio"],[role="menuitem"]').forEach(el=>{
      if(el.offsetParent!==null) out.push((el.textContent||'').trim().slice(0,60));
    });
    return [...new Set(out)];
  })()`);
  console.log('[5] ★★ 下拉项:', dump(opts));
  console.log('[6] preset 探针:', dump(await probe(c)));

  await c.eval(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
})();
