// audit-session-provider.mjs — 抓当前会话的 provider / agent 选择器真实条目 + 会话归属
const PORT = process.argv[2] || '9333';
const BASE = `http://127.0.0.1:${PORT}`;
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
      awaitPromise: !!opts.awaitPromise, returnByValue: true, timeout: (opts.timeout || 15000) });
    if (r.__timeout) return { __timeout: true };
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  }
}
const dump = o => JSON.stringify(o);

(async () => {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const win = list.filter(t => t.type === 'page').find(p => /sessions|智能体/i.test(p.title + p.url));
  const c = new CDP(win.webSocketDebuggerUrl); await c.connect();
  await c.send('Runtime.enable');

  // 1) 全面扫 DOM 里所有 aria-label / title 含 provider 关键字的元素
  console.log("[1] provider-ish aria/title:", dump(await c.eval(`(()=>{
    const out=new Set();
    document.querySelectorAll('*').forEach(el=>{
      for(const a of ['aria-label','title','data-tooltip']){
        const v=el.getAttribute&&el.getAttribute(a);
        if(v && /agent|copilot|dsh|bowei|claude|codex|provider|智能体|代理/i.test(v) && v.length<90) out.add(v);
      }
    });
    return [...out].slice(0,50);
  })()`)));

  // 2) 会话头部那条 "Agent"（模式）与旁边的 provider 标签
  console.log("\n[2] chat header region:", dump(await c.eval(`(()=>{
    const t=(document.body.innerText||'').split('\\n').map(s=>s.trim()).filter(Boolean);
    return t.slice(0,25);
  })()`)));

  // 3) 状态栏/下半部分文本
  console.log("\n[3] tail text:", dump(await c.eval(`(()=>{
    const t=(document.body.innerText||'').split('\\n').map(s=>s.trim()).filter(Boolean);
    return t.slice(-25);
  })()`)));

  // 4) monaco 内部：尝试拿到 chatSessionsService / provider 列表（若挂在 window 上）
  console.log("\n[4] service roots:", dump(await c.eval(`(()=>{
    const roots=[];
    const seen=new Set();
    const walk=(o,d)=>{ if(!o||d>2||seen.has(o))return; seen.add(o);
      for(const k of Object.keys(o)){ try{ const v=o[k]; if(v&&typeof v==='object'&&/service|provider|session|chat/i.test(k)) roots.push(k); }catch(_){} }
    };
    walk(window,0);
    return [...new Set(roots)].slice(0,40);
  })()`)));

  process.exit(0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
