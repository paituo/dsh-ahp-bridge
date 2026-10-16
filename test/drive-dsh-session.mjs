// drive-dsh-session.mjs — 真实选中 DSH 自定义 agent → 发消息 → 观察全链路（协议是否正常）
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
  async insertText(t) { return await this.send('Input.insertText', { text: t }); }
  async pressEnter() {
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await this.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dump = o => JSON.stringify(o);

(async () => {
  const MSG = process.argv[3] || '请只回复四个字：自定义智能体正常';
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const win = list.filter(t => t.type === 'page').find(p => /sessions|智能体/i.test(p.title + p.url));
  const c = new CDP(win.webSocketDebuggerUrl); await c.connect();
  await c.send('Runtime.enable');

  // 1) 打开会话类型下拉
  const sel = await c.eval(`(()=>{const el=[...document.querySelectorAll('[aria-label]')].find(e=>/选择会话类型/.test(e.getAttribute('aria-label')||''));if(!el)return{notFound:true};const r=el.getBoundingClientRect();return{rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]};})()`);
  if (!sel.rect) { console.log("no selector"); process.exit(1); }
  await c.mouse(sel.rect[0] + sel.rect[2] / 2, sel.rect[1] + sel.rect[3] / 2);
  await sleep(1200);

  // 2) 找到 "DSH (DeepSeek Harness)" 条目并点击
  const item = await c.eval(`(()=>{
    const rows=[...document.querySelectorAll('.monaco-list-row,[role="menuitem"],[role="option"]')];
    const t=rows.find(e=>/DSH\\s*\\(DeepSeek Harness\\)/.test((e.textContent||'')));
    if(!t) return {notFound:true, sample:rows.map(e=>(e.textContent||'').trim().slice(0,30)).slice(-6)};
    const r=t.getBoundingClientRect(); return {found:true, rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)], text:(t.textContent||'').trim()};
  })()`);
  console.log("[2] DSH item:", dump(item));
  if (!item.found) { process.exit(1); }
  await c.mouse(item.rect[0] + item.rect[2] / 2, item.rect[1] + item.rect[3] / 2);
  await sleep(1500);

  // 3) 确认选择器 label 变化
  console.log("\n[3] selector now:", await c.eval(`(()=>{const el=[...document.querySelectorAll('[aria-label]')].find(e=>/选择会话类型/.test(e.getAttribute('aria-label')||''));return el?el.getAttribute('aria-label'):'(none)';})()`));

  // 4) 聚焦输入框 + 输入 + 回车
  const ti = await c.eval(`(()=>{const ta=document.querySelector('textarea.ime-text-area')||document.querySelector('textarea');if(!ta)return{notFound:true};const r=ta.getBoundingClientRect();return{rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]};})()`);
  if (!ti.rect) { console.log("no input"); process.exit(1); }
  await c.mouse(ti.rect[0] + ti.rect[2] / 2, ti.rect[1] + ti.rect[3] / 2);
  await sleep(400);
  await c.insertText(MSG);
  await sleep(400);
  await c.pressEnter();
  console.log("\n[4] sent:", MSG);

  // 5) 观察 120s
  let last = '';
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const st = await c.eval(`(()=>{
      const t=document.body.innerText||'';
      const sel=[...document.querySelectorAll('[aria-label]')].find(e=>/选择会话类型/.test(e.getAttribute('aria-label')||''));
      const stop=!!document.querySelector('[aria-label*="停止"],[class*="codicon-stop"]');
      const errLines=t.split('\\n').map(s=>s.trim()).filter(l=>/错误|Error|失败|Authentication|never created/i.test(l)).slice(0,4);
      const tail=t.split('\\n').map(s=>s.trim()).filter(Boolean).slice(-6);
      return {type:sel?sel.getAttribute('aria-label'):'?', stop, errLines, tail};
    })()`);
    const sig = dump(st);
    if (sig !== last) { console.log(`[${(i + 1) * 3}s] type=${st.type} busy(stop)=${st.stop}`); console.log("   tail:", st.tail.join(' | ').slice(0, 200)); if (st.errLines.length) console.log("   ERR:", st.errLines.join(' || ')); last = sig; }
    if (st.tail.join(' ').match(/正常|协议|出错|错误|Authentication/i) && !st.stop) break;
  }
  process.exit(0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
