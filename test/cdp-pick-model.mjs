// cdp-pick-model.mjs — 在 UI 上切换模型到可用 provider，然后发消息验证
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
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  async insertText(text) { return await this.send('Input.insertText', { text }); }
  async pressEnter() {
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await this.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  }
}

// 从 UI 找模型选择器并列出可选项
async function listModelOptions(c) {
  return await c.eval(`(() => {
    const out = { triggers: [], options: [] };
    // 模型选择器通常在输入区下方，显示当前模型名
    document.querySelectorAll('[class*="model"], [aria-label*="模型"], [aria-label*="model"]').forEach(e => {
      const r = e.getBoundingClientRect();
      const txt = (e.textContent||'').trim().replace(/\\s+/g,' ');
      if (r.width > 0 && txt) out.triggers.push({
        cls:(typeof e.className==='string'?e.className:'').slice(0,60),
        aria:(e.getAttribute('aria-label')||'').slice(0,60), txt: txt.slice(0,60),
        rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)] });
    });
    return out;
  })()`);
}

async function main() {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const sess = list.find((t) => /sessions/.test(t.url));
  const c = await new CDP(sess.webSocketDebuggerUrl).connect();
  await c.send('Runtime.enable');

  // Esc 收敛
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(500);

  console.log('=== [1] 找模型选择器 ===');
  console.log(JSON.stringify(await listModelOptions(c), null, 2));

  console.log('\n=== [2] 全页搜"Qwen3.8-Flash-AI"出现位置 ===');
  console.log(JSON.stringify(await c.eval(`(() => {
    const out = [];
    document.querySelectorAll('*').forEach(e => {
      if (e.children.length === 0 && /Qwen3\\.8-Flash-AI|deepseek-v4\\.1-flash/i.test(e.textContent||'')) {
        const r = e.getBoundingClientRect();
        out.push({ tag:e.tagName, cls:(typeof e.className==='string'?e.className:'').slice(0,70),
                   txt:(e.textContent||'').trim().slice(0,60),
                   rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)],
                   vis: r.width>0 });
      }
    });
    return out.slice(0,15);
  })()`), null, 2));

  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
