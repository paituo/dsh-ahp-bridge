// audit-custom-agent.mjs — 自定义 agent（dsh provider）协议与使用的真机实测
const PORT = process.argv[2] || '9333';
const BASE = `http://127.0.0.1:${PORT}`;
class CDP {
  constructor(u) { this.u = u; this.id = 0; this.pending = new Map(); }
  connect() {
    return new Promise((res, rej) => {
      const ws = new WebSocket(this.u); this.ws = ws;
      ws.onopen = () => res(this);
      ws.onerror = e => rej(new Error('ws ' + (e.message || e)));
      ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } };
    });
  }
  send(method, params = {}, timeout = 20000) {
    const id = ++this.id;
    return new Promise(resolve => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); resolve({ __timeout: true }); } }, timeout);
    });
  }
  async eval(expr, opts = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(()=>{try{return (${expr});}catch(e){return {__err:String(e&&e.message||e)};}})()`,
      awaitPromise: !!opts.awaitPromise, returnByValue: true, timeout: 15000,
    });
    if (r.__timeout) return { __timeout: true };
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  }
}
(async () => {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const pages = list.filter(t => t.type === 'page');
  console.log("PAGES:", JSON.stringify(pages.map(p => [p.title, p.url.slice(0, 70)])));
  const win = pages.find(p => /sessions|agents|智能体/i.test(p.title + p.url)) || pages[0];
  if (!win) { console.log("NO PAGE"); process.exit(2); }
  const c = new CDP(win.webSocketDebuggerUrl); await c.connect();
  await c.send('Runtime.enable');

  console.log("\n[1] document:", JSON.stringify(await c.eval(
    `({url:location.href,title:document.title,bodyLen:document.body.innerHTML.length,els:document.querySelectorAll('*').length})`)));

  console.log("\n[2] globals probe:", JSON.stringify(await c.eval(`(()=>{
    const keys=Object.keys(globalThis).filter(k=>/agent|provider|chat|session|ahp|host/i.test(k));
    return {n:keys.length, keys:keys.slice(0,60)};
  })()`)));

  const texts = await c.eval(`(()=>{
    const out=[];
    document.querySelectorAll('[role="combobox"],[aria-haspopup],[class*="picker"],[class*="dropdown"]').forEach(el=>{
      const t=(el.textContent||'').trim(); if(t&&t.length<80) out.push(t);
    });
    return Array.from(new Set(out)).slice(0,40);
  })()`);
  console.log("\n[3] picker texts:", JSON.stringify(texts));

  console.log("\n[4] mentions:", JSON.stringify(await c.eval(`(()=>{
    const t=document.body.innerText||'';
    const find=(w)=>{const i=t.indexOf(w);return i<0?null:t.slice(Math.max(0,i-40),i+60);};
    return {dsh:!!t.match(/DSH|DeepSeek Harness/i), dshCtx:find('DSH'), errCtx:find('错误')};
  })()`)));

  console.log("\n[5] errors on page:", JSON.stringify(await c.eval(`(()=>{
    const t=document.body.innerText||'';
    return t.split('\\n').filter(l=>/错误|error|失败|never created|timeout/i.test(l)).slice(0,10);
  })()`)));
  process.exit(0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
