// cdp-real-send.mjs — 用真实键盘事件在智能体窗口输入并发送
const PORT = process.argv[2] || '9333';
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.onopen = () => resolve(this);
      ws.onerror = (e) => reject(new Error('ws error: ' + (e.message || e)));
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
      };
    });
  }
  send(method, params = {}, timeout = 25000) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); resolve({ __timeout: true }); } }, timeout);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(() => { try { return (${expr}); } catch (e) { return { __err: String(e && e.message || e) }; } })()`,
      returnByValue: true, timeout: 20000,
    });
    if (r.__timeout) return { __timeout: true };
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  }
  // 真实键盘：insertText 是最可靠的方式（Chromium 会走 IME 管线）
  async insertText(text) {
    return await this.send('Input.insertText', { text });
  }
  async keyDown(key, code, vk) {
    return await this.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    });
  }
  async keyUp(key, code, vk) {
    return await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    });
  }
  async pressEnter() {
    await this.keyDown('Enter', 'Enter', 13);
    await this.send('Input.dispatchKeyEvent', {
      type: 'char', text: '\r', unmodifiedText: '\r', key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });
    await this.keyUp('Enter', 'Enter', 13);
  }
}

async function main() {
  const MSG = process.argv[3] || '请只回复四个字：CDP链路正常';
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const sess = list.find((t) => /sessions/.test(t.url));
  if (!sess) { console.error('无智能体窗口'); process.exit(1); }
  const c = await new CDP(sess.webSocketDebuggerUrl).connect();
  await c.send('Runtime.enable');

  console.log('=== [1] 先建一个全新会话（点侧边栏"新会话"） ===');
  const r0 = await c.eval(`(() => {
    const el = [...document.querySelectorAll('[aria-label]')].find(e =>
      /新会话\\(Control\\+N\\)/.test((e.getAttribute('aria-label')||'').trim()));
    if (!el) return { notFound: true };
    el.click(); return { clicked: true };
  })()`);
  console.log(JSON.stringify(r0));
  await sleep(3500);

  console.log('\n=== [2] 定位输入框并聚焦（用真实 focus + click） ===');
  const ti = await c.eval(`(() => {
    const ta = document.querySelector('textarea.ime-text-area') || document.querySelector('textarea');
    if (!ta) return { notFound: true };
    const r = ta.getBoundingClientRect();
    return { found: true, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
             focused: document.activeElement === ta,
             placeholder: ta.placeholder || '', ariaLabel: ta.getAttribute('aria-label') || '' };
  })()`);
  console.log(JSON.stringify(ti, null, 2));
  if (!ti.found) { process.exit(1); }

  // 真实鼠标点击输入框中心
  const [x, y, w, h] = ti.rect;
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x + w/2, y: y + h/2, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + w/2, y: y + h/2, button: 'left', clickCount: 1 });
  await sleep(500);
  console.log('  点击后 focused =', JSON.stringify(await c.eval(`document.activeElement && document.activeElement.tagName + '.' + (document.activeElement.className||'')`)));

  console.log('\n=== [3] 用 Input.insertText 真实输入 ===');
  const ins = await c.insertText(MSG);
  console.log('  insertText 结果:', JSON.stringify(ins));
  await sleep(600);
  console.log('  输入框内容 =', JSON.stringify(await c.eval(`(() => {
    const ta = document.querySelector('textarea.ime-text-area') || document.querySelector('textarea');
    return ta ? (ta.value || '').slice(0,80) : null;
  })()`)));

  console.log('\n=== [4] 回车发送 ===');
  await c.pressEnter();
  await sleep(1200);

  console.log('\n=== [5] 观察 90s（查 turn 迹象） ===');
  let lastSig = '';
  for (let i = 0; i < 30; i++) {
    await sleep(3000);
    const st = await c.eval(`(() => {
      const t = document.body.innerText || '';
      const lines = t.split('\\n').map(s=>s.trim()).filter(Boolean);
      const stop = !!document.querySelector('[aria-label*="停止"], [class*="codicon-stop"]');
      const busy = !!document.querySelector('[class*="codicon-loading"], .codicon-sync');
      // 找消息区
      const msgs = [...document.querySelectorAll('[class*="rendered-markdown"], [class*="chat-response"], [class*="message-content"]')]
        .map(e => (e.innerText||'').trim().replace(/\\s+/g,' ').slice(0,150)).filter(Boolean);
      return { stop, busy, nMsg: msgs.length, tail: lines.slice(-8), msgs: msgs.slice(-3) };
    })()`);
    const sig = JSON.stringify(st);
    if (sig !== lastSig) {
      console.log(`  [${(i+1)*3}s] stop=${st.stop} busy=${st.busy} nMsg=${st.nMsg}`);
      console.log(`         tail: ${st.tail.join(' | ').slice(0,220)}`);
      if (st.msgs.length) console.log(`         msg:  ${st.msgs.join(' || ').slice(0,220)}`);
      lastSig = sig;
    }
    if (st.tail.join(' ').match(/CDP|链路正常|出错|错误|失败|Error/i)) break;
  }

  console.log('\n=== [6] 最终 body 尾部 ===');
  console.log(JSON.stringify(await c.eval(`(document.body.innerText||'').split('\\n').map(s=>s.trim()).filter(Boolean).slice(-30)`), null, 2));

  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
