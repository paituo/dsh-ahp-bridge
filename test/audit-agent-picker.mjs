// audit-agent-picker.mjs — 展开 agent 选择器，枚举候选 provider，并检查会话 provider 归属
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
      awaitPromise: !!opts.awaitPromise, returnByValue: true, timeout: opt(opts), });
    if (r.__timeout) return { __timeout: true };
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  }
}
function opt(o) { return o.timeout || 15000; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dump = (o) => JSON.stringify(o);

(async () => {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const win = list.filter(t => t.type === 'page').find(p => /sessions|智能体/i.test(p.title + p.url));
  const c = new CDP(win.webSocketDebuggerUrl); await c.connect();
  await c.send('Runtime.enable');

  // A) 抓当前会话卡片 / provider 归属（从 DOM 找 data-* 与 aria 线索）
  console.log("[A] session-card attrs:", dump(await c.eval(`(()=>{
    const out=[];
    document.querySelectorAll('[data-provider],[data-agent],[data-session-provider],[class*="session-item"],[class*="chat-item"]').forEach(el=>{
      const a={}; for(const n of el.getAttributeNames()) if(/provider|agent|session|kind|type/i.test(n)) a[n]=el.getAttribute(n);
      if(Object.keys(a).length) out.push({cls:el.className.slice(0,60),attrs:a,txt:(el.textContent||'').trim().slice(0,60)});
    });
    return out.slice(0,20);
  })()`)));

  // B) localStorage / vscdb 里记录的会话 provider（renderer 侧可读的存储）
  console.log("\n[B] localStorage keys:", dump(await c.eval(`(()=>{
    const ks=[]; for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i); if(/agent|session|provider|chat/i.test(k)) ks.push(k);}
    return ks.slice(0,40);
  })()`)));

  // C) 直接找 agent 选择器的按钮并点开，枚举选项
  const opened = await c.eval(`(()=>{
    const cands=[...document.querySelectorAll('button,[role="button"],[aria-haspopup="menu"],[aria-haspopup="listbox"]')];
    const target=cands.find(el=>/Agent|代理|智能体/i.test((el.textContent||'').trim()) && (el.textContent||'').trim().length<20);
    if(!target) return {found:false, sample: cands.slice(0,10).map(e=>(e.textContent||'').trim().slice(0,30))};
    target.click();
    return {found:true, label:(target.textContent||'').trim()};
  })()`);
  console.log("\n[C] clicked agent picker:", dump(opened));
  await sleep(1200);

  // D) 枚举下拉里的可见选项（provider 名）
  console.log("\n[D] dropdown options:", dump(await c.eval(`(()=>{
    const out=[];
    document.querySelectorAll('[role="menuitem"],[role="option"],.monaco-list-row,[class*="action-label"]').forEach(el=>{
      const t=(el.textContent||'').trim(); if(t && t.length<60) out.push(t);
    });
    return Array.from(new Set(out)).slice(0,40);
  })()`)));

  // E) 全页搜 "DSH" / "Bowei" / provider 名
  console.log("\n[E] provider name search:", dump(await c.eval(`(()=>{
    const t=document.body.innerText||'';
    const hits={}; for(const w of ['DSH','Bowei','DeepSeek Harness','agent-host-dsh','dsh']) { const i=t.indexOf(w); hits[w]= i<0?null:t.slice(Math.max(0,i-30),i+50); }
    return hits;
  })()`)));

  process.exit(0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
