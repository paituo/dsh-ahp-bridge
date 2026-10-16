// verify-live-routeB.mjs — 活体验证：Agents 窗口是否把 agenthost-dsh 识别为可用 provider + agent picker 是否有 preset
const PORT = process.argv[2] || '9333';
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      awaitPromise: !!opts.awaitPromise, returnByValue: true, timeout: opts.timeout || 15000 });
    if (r.__timeout) return { __timeout: true };
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  }
}
const dump = (o) => JSON.stringify(o);

(async () => {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const win = list.filter(t => t.type === 'page').find(p => /sessions/i.test(p.url) || /Agent/i.test(p.title));
  if (!win) { console.log('FATAL: Agents 窗口 target 未找到'); process.exit(1); }
  console.log('Agents target:', win.title, '|', win.url.slice(0, 90));
  const c = new CDP(win.webSocketDebuggerUrl); await c.connect();
  await c.send('Runtime.enable');

  // ── 1) 抓整页可见文本，找 provider 名与 preset 名
  const bodyText = await c.eval(`document.body.innerText`);
  const text = typeof bodyText === 'string' ? bodyText : '';
  const probes = {
    'DSH (DeepSeek Harness)': text.includes('DSH (DeepSeek Harness)'),
    'deepseek harness (loose)': /deepseek harness/i.test(text),
    'LobsterAI': text.includes('LobsterAI'),
    'HydraFusion': text.includes('HydraFusion'),
    // preset 显示名（路线B目标）
    '标准模式': text.includes('标准模式'),
    'PTC 模式': text.includes('PTC'),
    '极简模式': text.includes('极简'),
    '创作者模式': text.includes('创作者'),
    '梁神模式': text.includes('梁神'),
  };
  console.log('\n[1] 文本探针:');
  for (const [k, v] of Object.entries(probes)) console.log(`   ${v ? '✅' : '❌'} ${k}`);

  // ── 2) 找 provider 选择/会话类型下拉的服务端数据（DOM 里 provider 相关 aria）
  const aria = await c.eval(`(()=>{
    const out=[];
    document.querySelectorAll('[aria-label],[title],[role="option"],[role="menuitem"]').forEach(el=>{
      const t=(el.getAttribute('aria-label')||el.getAttribute('title')||el.textContent||'').trim();
      if(t && t.length<60 && /dsh|lobster|hydra|provider|会话|模式|agent/i.test(t)) out.push(t);
    });
    return [...new Set(out)].slice(0,40);
  })()`);
  console.log('\n[2] provider/模式 相关 aria:', dump(aria));

  // ── 3) 会话类型下拉（New 会话）里枚举 provider
  const openNewBtn = await c.eval(`(()=>{
    const btns=[...document.querySelectorAll('button,[role="button"],a')];
    const t=btns.find(el=>/新|New/i.test((el.textContent||'').trim()) && (el.textContent||'').trim().length<20);
    if(t){t.click(); return {clicked:true, label:(t.textContent||'').trim()};}
    return {clicked:false};
  })()`);
  console.log('\n[3] 点击"新会话":', dump(openNewBtn));
  await sleep(1500);

  const afterNew = await c.eval(`document.body.innerText`);
  const t2 = typeof afterNew === 'string' ? afterNew : '';
  console.log('\n[4] 新会话面板里的 preset/provider 探针:');
  for (const k of ['标准模式','PTC','极简','创作者','梁神','DSH (DeepSeek Harness)','LobsterAI','HydraFusion']) {
    console.log(`   ${t2.includes(k) ? '✅' : '❌'} ${k}`);
  }

  // ── 5) 直接问 VS Code commands（若 renderer 暴露）
  const provs = await c.eval(`(async()=>{
    try{
      const cmd=(window.vscode&&window.vscode.commands)||null;
      if(!cmd) return {noApi:true};
      return {ok:true};
    }catch(e){return {err:String(e)};}
  })()`, { awaitPromise: true });
  console.log('\n[5] renderer API 探测:', dump(provs));

  console.log('\n=== 结果 ===');
  const p1 = probes['DSH (DeepSeek Harness)'] || probes['deepseek harness (loose)'];
  console.log((p1 ? '✅' : '❌') + ' agenthost-dsh provider 已被 Agents 窗口识别');
  const presetHit = ['标准模式','PTC 模式','极简模式','创作者模式','梁神模式'].filter(k => probes[k]);
  console.log((presetHit.length ? '✅' : '❌') + ' preset 显示名出现在 UI: ' + dump(presetHit));
})();
