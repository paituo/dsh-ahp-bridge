// cdp-agents-open.mjs — 通过 CDP 找到并点击"打开 Agents 窗口"入口，触发新 renderer
const PORT = process.argv[2] || '9333';
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.events = []; }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.onopen = () => resolve(this);
      ws.onerror = (e) => reject(new Error('ws error: ' + (e.message || e)));
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
        else if (m.method) this.events.push(m);
      };
    });
  }
  send(method, params = {}, timeout = 20000) {
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
      awaitPromise: !!opts.awaitPromise, returnByValue: true, timeout: 15000,
    });
    if (r.__timeout) return { __timeout: true };
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  }
}

async function main() {
  const list0 = await (await fetch(`${BASE}/json/list`)).json();
  const page = list0.find((t) => t.type === 'page' && /workbench/.test(t.url)) || list0[0];
  const c = await new CDP(page.webSocketDebuggerUrl).connect();
  await c.send('Runtime.enable');
  await c.send('DOM.enable');

  console.log('=== [1] 定位 Agents 入口元素 ===');
  const found = await c.eval(`(() => {
    const out = [];
    document.querySelectorAll('*').forEach(e => {
      const c = typeof e.className === 'string' ? e.className : '';
      if (/open-in-agents|unified-agents-bar|agent-status-pill/i.test(c)) {
        const r = e.getBoundingClientRect();
        out.push({
          cls: c.slice(0, 70),
          tag: e.tagName,
          aria: (e.getAttribute('aria-label') || '').slice(0, 60),
          title: (e.getAttribute('title') || '').slice(0, 60),
          text: (e.textContent || '').trim().slice(0, 50),
          rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          visible: r.width > 0 && r.height > 0,
        });
      }
    });
    return out.slice(0, 25);
  })()`);
  console.log(JSON.stringify(found, null, 2));

  // 点击 open-in-agents 入口
  console.log('\n=== [2] 点击 open-in-agents-titlebar-widget ===');
  const clickRes = await c.eval(`(() => {
    const el = document.querySelector('.open-in-agents-titlebar-widget') ||
               document.querySelector('[class*="open-in-agents"]');
    if (!el) return { notFound: true };
    el.click();
    return { clicked: true, cls: el.className };
  })()`);
  console.log(JSON.stringify(clickRes, null, 2));

  await sleep(5000);
  console.log('\n=== [3] 点击后的 targets ===');
  const list1 = await (await fetch(`${BASE}/json/list`)).json();
  for (const t of list1) console.log(`  [${t.type}] ${t.title}  ${(t.url || '').slice(0, 130)}`);

  console.log('\n=== [4] 主 renderer 里的窗口/编辑器状态 ===');
  console.log(JSON.stringify(await c.eval(`(() => {
    const out = {};
    out.title = document.title;
    // 找所有 webview / iframe
    out.iframes = [...document.querySelectorAll('iframe')].map(f => (f.src || '').slice(0, 130));
    // 当前活动的编辑器 tab
    out.editorTabs = [...document.querySelectorAll('.tab .label-name, .tabs-container .tab')]
      .map(t => (t.textContent || '').trim().slice(0, 60)).filter(Boolean).slice(0, 10);
    return out;
  })()`), null, 2));

  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
