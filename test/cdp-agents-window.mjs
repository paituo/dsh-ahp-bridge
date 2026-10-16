// cdp-agents-window.mjs — 连上"智能体"窗口 renderer，检查会话类型/provider/AHP 状态
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
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const sess = list.find((t) => /sessions/.test(t.url)) || list.find((t) => t.type === 'page' && t !== list[0]);
  if (!sess) { console.error('未找到智能体窗口 target'); process.exit(1); }
  console.log(`连接智能体窗口: ${sess.title}`);
  console.log(`  url: ${sess.url.slice(0, 130)}`);

  const c = await new CDP(sess.webSocketDebuggerUrl).connect();
  await c.send('Runtime.enable');

  console.log('\n=== [1] 页面标题与全局 ===');
  console.log(JSON.stringify(await c.eval(`(() => ({
    title: document.title,
    hasVscode: typeof window.vscode,
    product: window._VSCODE_PRODUCT_JSON ? window._VSCODE_PRODUCT_JSON.nameLong : null,
    bodyText: (document.body.innerText || '').slice(0, 600),
  }))()`), null, 2));

  console.log('\n=== [2] 会话类型 / provider 相关 DOM ===');
  console.log(JSON.stringify(await c.eval(`(() => {
    const cls = new Set();
    document.querySelectorAll('*').forEach(e => {
      const cc = typeof e.className === 'string' ? e.className : '';
      cc.split(/\\s+/).forEach(x => { if (/session|agent|provider|picker|dropdown|chat/i.test(x)) cls.add(x); });
    });
    return {
      classes: [...cls].slice(0, 60),
      buttons: [...document.querySelectorAll('button, [role=button]')].map(b =>
        (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 50)).filter(Boolean).slice(0, 30),
    };
  })()`), null, 2));

  console.log('\n=== [3] 找"新建会话"下拉并展开 ===');
  const picker = await c.eval(`(() => {
    // 常见结构：titlebar 右侧的会话类型选择器
    const cands = [...document.querySelectorAll('[aria-label], [role=button], button')].filter(e => {
      const l = ((e.getAttribute('aria-label') || '') + ' ' + (e.textContent || '')).toLowerCase();
      return /新建|new|会话|session|登录|sign in|类型/.test(l);
    });
    return cands.slice(0, 15).map(e => ({
      tag: e.tagName, cls: (typeof e.className === 'string' ? e.className : '').slice(0, 60),
      aria: (e.getAttribute('aria-label') || '').slice(0, 70),
      text: (e.textContent || '').trim().slice(0, 60),
    }));
  })()`);
  console.log(JSON.stringify(picker, null, 2));

  console.log('\n=== [4] 点击会话类型下拉 ===');
  const clicked = await c.eval(`(() => {
    const el = [...document.querySelectorAll('[aria-label], [role=button], button')].find(e => {
      const l = ((e.getAttribute('aria-label') || '') + ' ' + (e.textContent || ''))
        .toLowerCase();
      return /(新建|new).*(会话|session)|会话.*类型|session.*type|选择.*智能体|pick.*agent/i.test(l);
    });
    if (!el) return { notFound: true };
    el.click();
    return { clicked: true, aria: (el.getAttribute('aria-label') || '').slice(0, 80), text: (el.textContent||'').trim().slice(0, 60) };
  })()`);
  console.log(JSON.stringify(clicked, null, 2));

  await sleep(1500);
  console.log('\n=== [5] 下拉展开后的可选项（会话类型列表） ===');
  console.log(JSON.stringify(await c.eval(`(() => {
    const out = [];
    document.querySelectorAll('[role=menuitem], [role=option], .monaco-list-row, .quick-input-list-entry, [class*="dropdown"] li').forEach(e => {
      const t = (e.textContent || '').trim().replace(/\\s+/g, ' ');
      if (t) out.push({ text: t.slice(0, 90), cls: (typeof e.className === 'string' ? e.className : '').slice(0, 50) });
    });
    // 若没匹配到，dump 可见的浮层内容
    if (!out.length) {
      const overlays = [...document.querySelectorAll('[class*="context-view"], [class*="monaco-menu"], .quick-input-widget')];
      overlays.forEach(o => out.push({ overlay: (o.innerText || '').slice(0, 300) }));
    }
    return out.slice(0, 30);
  })()`), null, 2));

  console.log('\n=== done ===');
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
