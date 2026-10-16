// cdp-probe.mjs — 通过 CDP 探测 VS Code 内部状态（Agents / AHP / DSH 相关）
// 用法: node cdp-probe.mjs [port]
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
        if (m.id && this.pending.has(m.id)) {
          this.pending.get(m.id)(m); this.pending.delete(m.id);
        }
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
      expression: expr, awaitPromise: !!opts.awaitPromise,
      returnByValue: true, timeout: 15000,
    });
    if (r.__timeout) return { __timeout: true };
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text || r.result.exceptionDetails.exception?.description };
    return r.result?.result?.value;
  }
}

async function main() {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /workbench/.test(t.url)) || list[0];
  if (!page) { console.error('无 page target'); process.exit(1); }
  console.log(`连接: ${page.title}  ${page.url.slice(0, 90)}`);
  const c = await new CDP(page.webSocketDebuggerUrl).connect();
  await c.send('Runtime.enable');

  // 1) 全局对象探测
  console.log('\n=== [1] renderer 全局对象 ===');
  const globals = await c.eval(`(() => {
    const ks = Object.getOwnPropertyNames(window).filter(k =>
      /vscode|require|monaco|_VSCODE|workbench|agent/i.test(k));
    return { keys: ks.slice(0, 40), hasRequire: typeof require, hasDefine: typeof define };
  })()`);
  console.log(JSON.stringify(globals, null, 2));

  // 2) 尝试拿 VS Code API（require('vscode') 在 renderer 不可用，但可试 window.vscode）
  console.log('\n=== [2] 尝试加载 monaco/vscode 模块系统 ===');
  const mod = await c.eval(`(() => {
    try {
      // VS Code renderer 里可通过 globalThis 的 AMD loader
      if (typeof require !== 'undefined' && typeof require.config === 'function') {
        // electron renderer 的 node require
        const path = require('path');
        return { nodeRequire: true, path: typeof path.join };
      }
      return { nodeRequire: false };
    } catch (e) { return { err: String(e) }; }
  })()`);
  console.log(JSON.stringify(mod, null, 2));

  // 3) DOM 探测：Agents / Sessions 相关元素
  console.log('\n=== [3] DOM 中 Agents/Sessions 相关元素 ===');
  const dom = await c.eval(`(() => {
    const out = {};
    out.title = document.title;
    const all = [...document.querySelectorAll('[class], [id], [aria-label], [data-*]')];
    out.total = all.length;
    // 找含 agent/session/chat 的 class
    const cls = new Set();
    for (const el of all) {
      const c = (el.className || '').toString();
      if (/agent|session|chat/i.test(c)) cls.add(c.slice(0, 80));
    }
    out.agentClasses = [...cls].slice(0, 30);
    // 找 chat 相关 viewlet
    out.viewlets = [...document.querySelectorAll('.activitybar .action-item')].map(a =>
      (a.getAttribute('aria-label') || a.title || '').slice(0, 60)).filter(Boolean);
    return out;
  })()`);
  console.log(JSON.stringify(dom, null, 2));

  // 4) localStorage / IndexedDB 里的 agent 相关状态
  console.log('\n=== [4] localStorage 关键键 ===');
  const ls = await c.eval(`(() => {
    const o = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (/agent|session|chat|bowei|dsh|ahp/i.test(k)) o[k] = (localStorage.getItem(k) || '').slice(0, 200);
    }
    return { keys: Object.keys(o), sample: o };
  })()`);
  console.log(JSON.stringify(ls, null, 2));

  console.log('\n=== done ===');
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
