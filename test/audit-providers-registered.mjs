// audit-providers-registered.mjs — 通过 CDP 从 renderer 侧抓 "provider 列表 + 当前会话 provider"
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dump = o => JSON.stringify(o);

(async () => {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const win = list.filter(t => t.type === 'page').find(p => /sessions|智能体/i.test(p.title + p.url));
  const c = new CDP(win.webSocketDebuggerUrl); await c.connect();
  await c.send('Runtime.enable'); await c.send('DOM.enable');

  // 1) 找 "Agent" 选择器按钮（会话顶部那条 "Agent ▾"），点开
  const r1 = await c.eval(`(()=>{
    const els=[...document.querySelectorAll('button,[role="button"],a,[class*="action-label"],[class*="monaco-text-button"]')];
    const hits=els.filter(e=>{const t=(e.textContent||'').trim(); return /^(Agent|代理)$/.test(t);});
    return {n:hits.length, info:hits.map(e=>({cls:(e.className||'').slice(0,80), aria:e.getAttribute('aria-label'), hv:e.getAttribute('aria-haspopup')}))};
  })()`);
  console.log("[1] 'Agent' buttons:", dump(r1));

  const clicked = await c.eval(`(()=>{
    const els=[...document.querySelectorAll('button,[role="button"],a,[class*="action-label"]')];
    const t=els.find(e=>/^(Agent|代理)$/.test((e.textContent||'').trim()));
    if(!t) return {ok:false}; t.click(); return {ok:true, cls:(t.className||'').slice(0,80)};
  })()`);
  console.log("[2] clicked:", dump(clicked));
  await sleep(1000);

  // 3) 下拉/菜单里的所有可见项（provider 名应在此）
  console.log("[3] menu items after click:", dump(await c.eval(`(()=>{
    const out=[];
    document.querySelectorAll('[role="menuitemcheckbox"],[role="menuitemradio"],[role="menuitem"],[role="option"],.monaco-list-row,.action-label,.monaco-menu .action-item').forEach(el=>{
      const t=(el.textContent||'').trim(); if(t&&t.length<70) out.push(t);
    });
    return Array.from(new Set(out)).slice(0,50);
  })()`)));

  // 4) 关闭菜单（Esc）
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(300);

  // 5) 从 renderer 内部找会话状态里的 provider 字段（扫 monaco 的 context/service）
  console.log("[4] rendered provider strings (regex over innerText):", dump(await c.eval(`(()=>{
    const t=document.body.innerText||'';
    const m=[...t.matchAll(/(Copilot|Agent|DSH|Bowei|Custom Endpoint|Claude|Codex)[^\\n]{0,40}/g)].map(x=>x[0]).slice(0,25);
    return Array.from(new Set(m));
  })()`)));

  process.exit(0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
