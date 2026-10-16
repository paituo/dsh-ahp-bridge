// cdp-new-session-picker.mjs — 打开"新会话"下拉，抓取会话类型/provider 列表
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

async function dumpOverlay(c) {
  return await c.eval(`(() => {
    const out = [];
    // 下拉/菜单浮层
    document.querySelectorAll('[class*="context-view"], .monaco-menu, .monaco-list, [role=menu], .quick-input-widget').forEach(o => {
      const r = o.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const items = [...o.querySelectorAll('.monaco-list-row, [role=menuitem], [role=option], li, .action-item')]
          .map(e => (e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100)).filter(Boolean);
        out.push({ cls: (typeof o.className==='string'?o.className:'').slice(0,60),
                   rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)],
                   text: (o.innerText||'').slice(0,400), items: items.slice(0,20) });
      }
    });
    return out;
  })()`);
}

async function main() {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const sess = list.find((t) => /sessions/.test(t.url));
  if (!sess) { console.error('无智能体窗口'); process.exit(1); }
  const c = await new CDP(sess.webSocketDebuggerUrl).connect();
  await c.send('Runtime.enable');

  console.log('=== [0] 当前标题栏元素（找会话类型选择器） ===');
  console.log(JSON.stringify(await c.eval(`(() => {
    const out = [];
    document.querySelectorAll('.agent-sessions-titlebar-pill, .monaco-dropdown, .dropdown-action-container, [class*="titlebar"] [aria-label]').forEach(e => {
      const r = e.getBoundingClientRect();
      out.push({ cls:(typeof e.className==='string'?e.className:'').slice(0,70),
                 aria:(e.getAttribute('aria-label')||'').slice(0,70),
                 text:(e.textContent||'').trim().replace(/\\s+/g,' ').slice(0,80),
                 vis:r.width>0&&r.height>0 });
    });
    return out.slice(0,20);
  })()`), null, 2));

  console.log('\n=== [1] 查找并点击会话类型选择器 ===');
  const r1 = await c.eval(`(() => {
    const sels = [
      '.agent-sessions-titlebar-pill',
      '.monaco-dropdown-with-default .dropdown-action-container',
      '.monaco-dropdown .dropdown-label',
      '[aria-label*="会话类型"]',
      '[aria-label*="Agent"]',
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) {
        const rr = el.getBoundingClientRect();
        if (rr.width > 0) { el.click(); return { clicked: s, cls:(typeof el.className==='string'?el.className:'').slice(0,80), text:(el.textContent||'').trim().slice(0,80) }; }
      }
    }
    return { notFound: true };
  })()`);
  console.log(JSON.stringify(r1, null, 2));
  await sleep(1200);
  console.log('\n=== [1b] 点击后浮层 ===');
  console.log(JSON.stringify(await dumpOverlay(c), null, 2));

  console.log('\n=== [2] 尝试点"新会话"按钮 ===');
  const r2 = await c.eval(`(() => {
    const btns = [...document.querySelectorAll('[aria-label], button, [role=button]')];
    const el = btns.find(e => /新会话|new session|New$/i.test((e.getAttribute('aria-label')||'') + ' ' + (e.textContent||'')));
    if (!el) return { notFound:true };
    el.click();
    return { clicked:true, aria:(el.getAttribute('aria-label')||'').slice(0,70), text:(el.textContent||'').trim().slice(0,60) };
  })()`);
  console.log(JSON.stringify(r2, null, 2));
  await sleep(1500);
  console.log('\n=== [2b] 新会话后的浮层/视图 ===');
  console.log(JSON.stringify(await dumpOverlay(c), null, 2));

  console.log('\n=== [3] 全局：所有可见的 provider/agent 名称 ===');
  console.log(JSON.stringify(await c.eval(`(() => {
    const t = document.body.innerText || '';
    const lines = t.split('\\n').map(s=>s.trim()).filter(Boolean);
    const hits = lines.filter(l => /dsh|bowei|copilot|deepseek|harness|agent-host|claude|Qwen|模型|智能体|provider/i.test(l));
    return hits.slice(0, 40);
  })()`), null, 2));

  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
