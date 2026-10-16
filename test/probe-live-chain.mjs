// probe-live-chain.mjs — 在 Agents 窗口里实地走 getCustomAgents 那条链，定位空数组来源
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
      expression: `(async()=>{try{return (${expr});}catch(e){return {__err:String(e&&e.stack||e)};}})()`,
      awaitPromise: true, returnByValue: true, timeout: opts.timeout || 25000 });
    if (r.__timeout) return { __timeout: true };
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description||'') };
    return r.result?.result?.value;
  }
}
const dump = (o) => JSON.stringify(o);

(async () => {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const win = list.filter(t => t.type === 'page').find(p => /sessions/i.test(p.url));
  const c = new CDP(win.webSocketDebuggerUrl); await c.connect();
  await c.send('Runtime.enable');

  // A) 探测 agentHostAgentPicker 组件内部状态（若可从 DOM 反查 service）
  const A = await c.eval(`(()=>{
    // 列出 renderer 里所有可及的 service 单例（DI 容器常用的全局钩子）
    const found=[];
    for (const k of Object.keys(window)) {
      try {
        const v = window[k];
        if (v && typeof v === 'object' && v.constructor && /Service|Picker|AgentHost/i.test(v.constructor.name||'')) {
          found.push(k + ' :: ' + v.constructor.name);
        }
      } catch(e){}
    }
    return found.slice(0, 40);
  })()`);
  console.log('[A] renderer 全局对象里的 Service:', dump(A));

  // B) 找 agent picker 的 DOM 元素，读它的 title/aria 完整
  const B = await c.eval(`(()=>{
    const el=document.querySelector('.chat-agent-picker-item, [class*="agent-picker"]');
    if(!el) return {found:false};
    return {found:true, outerHTML:(el.outerHTML||'').slice(0,700)};
  })()`);
  console.log('\n[B] agent picker DOM:', dump(B));

  // C) 找当前会话卡片的 providerId（从 DOM 或 title 反查）
  const C = await c.eval(`(()=>{
    const out=[];
    document.querySelectorAll('[data-provider-id],[data-session-provider-id],[data-provider]').forEach(el=>{
      out.push({tag:el.tagName, pid:el.getAttribute('data-provider-id')||el.getAttribute('data-session-provider-id')||el.getAttribute('data-provider')});
    });
    // 也从 title 属性找
    document.querySelectorAll('[title*="agenthost"],[title*="DSH"]').forEach(el=>{
      out.push({tag:el.tagName, title:el.getAttribute('title'), cls:(el.className||'').slice(0,60)});
    });
    return out.slice(0,20);
  })()`);
  console.log('\n[C] 会话卡片里的 provider 线索:', dump(C));

  // D) ★ 直接问主进程：有哪些 sessions 与各自 providerId（通过 vscode API 若可及）
  const D = await c.eval(`(async()=>{
    try {
      // VS Code webview/renderer 常暴露 acquireVsCodeApi；sessions 窗口可能有 __sessions__
      const keys = Object.keys(window).filter(k=>/session|agent|provider/i.test(k));
      return {candidateKeys: keys.slice(0,40)};
    } catch(e){ return {err:String(e)}; }
  })()`);
  console.log('\n[D] window 上会话相关键:', dump(D));

  console.log('\n=== 结论提示 ===');
  console.log('若 [B] 显示只有 "Agent" 文本且无选项子节点 ⇒ 组件收到空数组（fallback 到 mode）');
})();
