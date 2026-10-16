// verify-hook-provider-id.mjs — 终极探针：hook _getProvider，打印 session.providerId
// 做法：利用 CDP 在 Agents 窗口注入一段 monkeypatch，拦截 agent picker 的 _getProvider 调用
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

  // 1) 从会话卡片 DOM 反查 providerId（VS Code 常把 provider 放进 data-* 或 title）
  const dom = await c.eval(`(()=>{
    const out=[];
    // 所有带 data-* 的元素
    document.querySelectorAll('*').forEach(el=>{
      for (const a of (el.getAttributeNames?el.getAttributeNames():[])) {
        if (/provider|session.*id|harness/i.test(a)) {
          out.push({tag:el.tagName, attr:a, val:(el.getAttribute(a)||'').slice(0,60)});
        }
      }
    });
    return out.slice(0,30);
  })()`);
  console.log('[1] DOM 里的 provider 线索:', dump(dom));

  // 2) 检查所有 iframe / webview
  const fr = await c.eval(`(()=>{
    return {iframes:[...document.querySelectorAll('iframe')].map(f=>({src:(f.src||'').slice(0,80), id:f.id})),
            webviews:[...document.querySelectorAll('webview')].length};
  })()`);
  console.log('[2] iframe/webview:', dump(fr));

  // 3) 尝试从 DOM 里找到 picker 组件实例（VS Code 常把 vm 挂在元素上）
  const vm = await c.eval(`(()=>{
    const el=document.querySelector('.chat-agent-picker-item, [class*="agent-picker"]');
    if(!el) return {found:false};
    const keys=[];
    for (const k of Object.keys(el)) { if (/vm|view|model|_|picker|agent/i.test(k)) keys.push(k); }
    // 也查 __proto__ 上的
    return {found:true, ownKeys:keys.slice(0,20),
      syms:Object.getOwnPropertySymbols(el).map(s=>s.toString()).slice(0,10)};
  })()`);
  console.log('[3] picker 元素上的实例键:', dump(vm));

  // 4) 直接找 renderer 里所有 picker 相关的全局
  const g = await c.eval(`(()=>{
    const hits=[];
    for (const k of Object.keys(window)) {
      try { const v=window[k]; if(v && typeof v==='object' && v.constructor && /Picker|AgentHost/i.test(v.constructor.name||'')) hits.push(k+'::'+v.constructor.name); } catch(e){}
    }
    return hits.slice(0,20);
  })()`);
  console.log('[4] window 上 Picker/AgentHost 对象:', dump(g));
})();
