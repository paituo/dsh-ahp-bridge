// cdp-chat-send.mjs — 在智能体窗口里真实发一条消息，全程观察 UI 事件
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
  async eval(expr, opts = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(() => { try { return (${expr}); } catch (e) { return { __err: String(e && e.message || e) }; } })()`,
      awaitPromise: !!opts.awaitPromise, returnByValue: true, timeout: 20000,
    });
    if (r.__timeout) return { __timeout: true };
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  }
  async key(type, key, code, keyCode) {
    await this.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  }
  async typeText(text) {
    for (const ch of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp' });
    }
  }
}

async function dumpChat(c) {
  return await c.eval(`(() => {
    const out = {};
    // 输入框
    const ta = document.querySelector('textarea, [contenteditable=true], .chat-input, [class*="input-area"] textarea');
    out.input = ta ? { tag: ta.tagName, cls: (typeof ta.className==='string'?ta.className:'').slice(0,70), ph: ta.placeholder||'' } : null;
    // 消息列表
    const rows = [...document.querySelectorAll('.monaco-list-row.request, .monaco-list-row.response, [class*="chat-message"], [class*="message-row"]')];
    out.messageRows = rows.map(r => (r.innerText||'').trim().replace(/\\s+/g,' ').slice(0,200)).slice(-8);
    // 整个 body 尾部
    out.bodyTail = (document.body.innerText||'').split('\\n').map(s=>s.trim()).filter(Boolean).slice(-25);
    return out;
  })()`);
}

async function main() {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const sess = list.find((t) => /sessions/.test(t.url));
  if (!sess) { console.error('无智能体窗口'); process.exit(1); }
  const c = await new CDP(sess.webSocketDebuggerUrl).connect();
  await c.send('Runtime.enable');

  // 先按 Esc 关掉可能的浮层
  await c.key('keyDown', 'Escape', 'Escape', 27);
  await c.key('keyUp', 'Escape', 'Escape', 27);
  await sleep(600);

  console.log('=== [1] 关闭浮层后，找输入框 ===');
  console.log(JSON.stringify(await dumpChat(c), null, 2));

  console.log('\n=== [2] 点"新会话"建立干净会话 ===');
  const newBtn = await c.eval(`(() => {
    // 侧边栏顶部的"新会话"按钮
    const el = [...document.querySelectorAll('[aria-label]')].find(e =>
      /新会话\\(Control\\+N\\)|^新会话$/.test((e.getAttribute('aria-label')||'').trim()));
    if (!el) return { notFound: true, labels: [...document.querySelectorAll('[aria-label]')].map(e=>e.getAttribute('aria-label')).filter(l=>l&&l.includes('会话')).slice(0,10) };
    el.click();
    return { clicked: true, aria: el.getAttribute('aria-label') };
  })()`);
  console.log(JSON.stringify(newBtn, null, 2));
  await sleep(3000);

  console.log('\n=== [2b] 新会话后的输入框状态 ===');
  console.log(JSON.stringify(await dumpChat(c), null, 2));

  console.log('\n=== [3] 聚焦输入框并输入测试消息 ===');
  const MSG = '请只回复四个字：CDP链路正常';
  const focusRes = await c.eval(`(() => {
    const ta = document.querySelector('textarea, [contenteditable=true]');
    if (!ta) return { noInput: true };
    ta.focus();
    if (ta.tagName === 'TEXTAREA') {
      // 用原生 setter 触发 React
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(MSG)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      ta.textContent = ${JSON.stringify(MSG)};
      ta.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(MSG)} }));
    }
    return { ok: true, tag: ta.tagName, value: ta.value || ta.textContent };
  })()`);
  console.log(JSON.stringify(focusRes, null, 2));
  await sleep(800);

  console.log('\n=== [4] 发送（回车） ===');
  const before = await c.eval(`(() => (document.querySelector('.monaco-list-row.response')||{}).innerText || '')()`);
  await c.key('keyDown', 'Enter', 'Enter', 13);
  await c.key('keyUp', 'Enter', 'Enter', 13);

  // 轮询观察 90 秒
  console.log('\n=== [5] 观察响应（最多 90s） ===');
  let last = '';
  for (let i = 0; i < 30; i++) {
    await sleep(3000);
    const st = await c.eval(`(() => {
      const responses = [...document.querySelectorAll('.monaco-list-row.response')];
      const lastResp = responses.length ? (responses[responses.length-1].innerText||'').trim().replace(/\\s+/g,' ') : '';
      const busy = !!document.querySelector('[class*="codicon-loading"], [class*="stop"], [aria-label*="停止"]');
      const tail = (document.body.innerText||'').split('\\n').map(s=>s.trim()).filter(Boolean).slice(-6);
      return { nResp: responses.length, lastResp: lastResp.slice(0,300), busy, tail };
    })()`);
    if (JSON.stringify(st) !== last) {
      console.log(`  [${(i+1)*3}s] resp=${st.nResp} busy=${st.busy}`);
      console.log(`         last: ${st.lastResp.slice(0,200)}`);
      last = JSON.stringify(st);
    }
    if (st.lastResp && /CDP|链路|正常|错误|error|失败/i.test(st.lastResp)) break;
  }

  console.log('\n=== [6] 最终状态 ===');
  console.log(JSON.stringify(await dumpChat(c), null, 2));

  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
