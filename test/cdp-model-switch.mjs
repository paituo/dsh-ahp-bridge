// cdp-model-switch.mjs — 点开模型选择器 → 列出可选项 → 选 bumen/deepseek-v4.1-flash → 发消息验证
const PORT = process.argv[2] || '9333';
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl); this.ws = ws;
      ws.onopen = () => resolve(this);
      ws.onerror = (e) => reject(new Error('ws error: ' + (e.message || e)));
      ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); } };
    });
  }
  send(method, params = {}, timeout = 25000) {
    const id = ++this.id;
    return new Promise((resolve) => { this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); resolve({ __timeout: true }); } }, timeout); });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(() => { try { return (${expr}); } catch (e) { return { __err: String(e && e.message || e) }; } })()`,
      returnByValue: true, timeout: 20000 });
    if (r.__timeout) return { __timeout: true };
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  }
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  async insertText(t) { return await this.send('Input.insertText', { text: t }); }
  async pressEnter() {
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await this.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  }
  async esc() {
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  }
}

async function main() {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const sess = list.find((t) => /sessions/.test(t.url));
  const c = await new CDP(sess.webSocketDebuggerUrl).connect();
  await c.send('Runtime.enable');

  // 新会话
  await c.eval(`(() => { const el=[...document.querySelectorAll('[aria-label]')].find(e=>/新会话\\(Control\\+N\\)/.test((e.getAttribute('aria-label')||'').trim())); if(el) el.click(); return 1; })()`);
  await sleep(3000);

  console.log('=== [1] 点击模型选择器 ===');
  const t = await c.eval(`(() => {
    const el = document.querySelector('.model-picker-item, [aria-label^="Models"], .chat-input-picker-split-button');
    if (!el) return { notFound: true };
    const r = el.getBoundingClientRect();
    return { rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
  })()`);
  console.log(JSON.stringify(t));
  const [mx, my, mw, mh] = t.rect;
  await c.click(mx + mw / 2, my + mh / 2);
  await sleep(1200);

  console.log('\n=== [2] 模型下拉可选项 ===');
  const opts = await c.eval(`(() => {
    const out = [];
    document.querySelectorAll('.monaco-list-row, [role=option], [role=menuitem], .action-menu-item, [class*="picker"] [class*="item"]').forEach(e => {
      const r = e.getBoundingClientRect();
      const txt = (e.textContent||'').trim().replace(/\\s+/g,' ');
      if (r.width > 0 && txt && txt.length < 120) out.push({ txt: txt.slice(0,90), rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)] });
    });
    return out.slice(0, 40);
  })()`);
  console.log(JSON.stringify(opts, null, 2));

  // 找可用模型（bumen / deepseek-v4.1-flash）
  const target = (opts || []).find((o) => /deepseek-v4\.1-flash|bumen/i.test(o.txt));
  if (target) {
    console.log(`\n=== [3] 选中: "${target.txt}" ===`);
    await c.click(target.rect[0] + target.rect[2] / 2, target.rect[1] + target.rect[3] / 2);
    await sleep(1000);
  } else {
    console.log('\n=== [3] 未找到 bumen/deepseek-v4.1-flash，Esc 关闭 ===');
    await c.esc(); await sleep(400);
  }

  console.log('\n=== [4] 当前模型 ===');
  console.log(JSON.stringify(await c.eval(`(() => {
    const el = document.querySelector('.model-picker-item .chat-input-picker-label, [aria-label^="Models"]');
    return el ? (el.textContent||'').trim().slice(0,60) : null;
  })()`)));

  console.log('\n=== [5] 输入并发送 ===');
  const ti = await c.eval(`(() => { const ta=document.querySelector('textarea.ime-text-area')||document.querySelector('textarea');
    if(!ta) return {notFound:true}; const r=ta.getBoundingClientRect();
    return {rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]}; })()`);
  await c.click(ti.rect[0] + ti.rect[2] / 2, ti.rect[1] + ti.rect[3] / 2);
  await sleep(300);
  await c.insertText('请只回复四个字：链路已验证');
  await sleep(500);
  await c.pressEnter();
  console.log('  已发送');

  console.log('\n=== [6] 观察 120s ===');
  let last = '';
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const st = await c.eval(`(() => {
      const t=(document.body.innerText||'').split('\\n').map(s=>s.trim()).filter(Boolean);
      const stop=!!document.querySelector('[aria-label*="停止"]');
      const err=t.find(l=>/错误|TURN_FAILED|Authentication|failed/i.test(l));
      return { stop, err: err ? err.slice(0,200) : null, tail: t.slice(-10) };
    })()`);
    const sig = JSON.stringify(st);
    if (sig !== last) {
      console.log(`  [${(i+1)*3}s] stop=${st.stop}`);
      if (st.err) console.log(`         !! ${st.err}`);
      console.log(`         ${st.tail.join(' | ').slice(0,230)}`);
      last = sig;
    }
    if (st.err) break;
    if (!st.stop && st.tail.join(' ').match(/链路已验证|4 个字|四个字/)) break;
  }

  console.log('\n=== [7] 最终 ===');
  console.log(JSON.stringify(await c.eval(`(document.body.innerText||'').split('\\n').map(s=>s.trim()).filter(Boolean).slice(-25)`), null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
