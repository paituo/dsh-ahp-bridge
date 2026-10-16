// audit-titlebar-agent.mjs — 找标题栏"会话类型/agent"下拉，枚举可选 agent（含 DSH）
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
  async mouse(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dump = o => JSON.stringify(o);

(async () => {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const win = list.filter(t => t.type === 'page').find(p => /sessions|智能体/i.test(p.title + p.url));
  const c = new CDP(win.webSocketDebuggerUrl); await c.connect();
  await c.send('Runtime.enable');

  // 标题栏里所有带 chevron / dropdown 的可见控件
  console.log("[1] titlebar dropdowns:", dump(await c.eval(`(()=>{
    const out=[];
    document.querySelectorAll('.monaco-dropdown, [class*="dropdown"], [aria-haspopup]').forEach(e=>{
      const r=e.getBoundingClientRect(); if(r.width<=0||r.height<=0||r.y>80) return;
      out.push({cls:(typeof e.className==='string'?e.className:'').slice(0,55), aria:(e.getAttribute('aria-label')||'').slice(0,50), text:(e.textContent||'').trim().slice(0,40), rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]});
    });
    return out.slice(0,15);
  })()`)));

  // 找 "与 Copilot 聊天" 这个 label 附近的可点控件（会话类型）
  console.log("\n[2] near 'Copilot' label:", dump(await c.eval(`(()=>{
    const out=[];
    document.querySelectorAll('*').forEach(e=>{
      const t=(e.textContent||'').trim();
      if(t && /^(与 .*聊天|Chat with)/.test(t) && t.length<30){
        const r=e.getBoundingClientRect(); out.push({tag:e.tagName, cls:(typeof e.className==='string'?e.className:'').slice(0,50), text:t, rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]});
      }
    });
    return out.slice(0,8);
  })()`)));

  // 直接找 aria-label 含 "agent"/"智能体"/"会话类型" 的可见按钮
  console.log("\n[3] agent-type buttons:", dump(await c.eval(`(()=>{
    const out=[];
    document.querySelectorAll('[aria-label],[role="button"]').forEach(e=>{
      const a=e.getAttribute&&e.getAttribute('aria-label')||'';
      if(!/agent|智能体|会话类型|session type|provider|自定义智能体/i.test(a)) return;
      const r=e.getBoundingClientRect(); if(r.width<=0) return;
      out.push({aria:a.slice(0,60), rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]});
    });
    return out.slice(0,15);
  })()`)));

  process.exit(0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
