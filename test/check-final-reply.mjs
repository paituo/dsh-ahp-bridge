// check-final-reply.mjs — 读取当前 DSH 会话的最终渲染回复
const PORT = process.argv[2] || '9333';
const BASE = `http://127.0.0.1:${PORT}`;
class CDP {
  constructor(u) { this.u = u; this.id = 0; this.pending = new Map(); }
  connect() { return new Promise((res, rej) => { const ws = new WebSocket(this.u); this.ws = ws;
    ws.onopen = () => res(this); ws.onerror = e => rej(new Error('ws ' + (e.message || e)));
    ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } }; }); }
  send(method, params = {}, timeout = 20000) { const id = ++this.id;
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
}
const dump = o => JSON.stringify(o, null, 1);
(async () => {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const win = list.filter(t => t.type === 'page').find(p => /sessions|智能体/i.test(p.title + p.url));
  const c = new CDP(win.webSocketDebuggerUrl); await c.connect();
  await c.send('Runtime.enable');
  console.log("[当前会话类型]:", await c.eval(`(()=>{const el=[...document.querySelectorAll('[aria-label]')].find(e=>/选择会话类型/.test(e.getAttribute('aria-label')||''));return el?el.getAttribute('aria-label'):'(none)';})()`));
  console.log("\n[消息区文本]:", dump(await c.eval(`(()=>{
    // 抓 chat 消息区里的 markdown/response 内容
    const out=[];
    document.querySelectorAll('[class*="rendered-markdown"],[class*="chat-response"],[class*="response-part"],[class*="markdown-body"]').forEach(e=>{
      const t=(e.innerText||'').trim(); if(t&&t.length<400) out.push(t);
    });
    return [...new Set(out)].slice(-12);
  })()`)));
  console.log("\n[页面最后 20 行]:", dump(await c.eval(`(document.body.innerText||'').split('\\n').map(s=>s.trim()).filter(Boolean).slice(-20)`)));
  process.exit(0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
