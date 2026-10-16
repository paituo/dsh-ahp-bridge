// cdp-probe2.mjs — 深探 VS Code renderer 内部（修正选择器 + 模块系统 + 会话面）
const PORT = process.argv[2] || '9333';
const BASE = `http://127.0.0.1:${PORT}`;

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
  console.log(`=== targets (${list.length}) ===`);
  for (const t of list) console.log(`  [${t.type}] ${t.title}  ${(t.url || '').slice(0, 110)}`);

  const page = list.find((t) => t.type === 'page' && /workbench/.test(t.url)) || list[0];
  const c = await new CDP(page.webSocketDebuggerUrl).connect();
  await c.send('Runtime.enable');

  console.log('\n=== [1] window.vscode 的形状 ===');
  console.log(JSON.stringify(await c.eval(`(() => {
    const v = window.vscode;
    if (!v) return { none: true };
    return { type: typeof v, keys: Object.keys(v).slice(0, 40),
             proto: Object.getOwnPropertyNames(Object.getPrototypeOf(v) || {}).slice(0, 30) };
  })()`), null, 2));

  console.log('\n=== [2] VS Code 模块系统（globalThis 里的 loader / service 容器） ===');
  console.log(JSON.stringify(await c.eval(`(() => {
    const cands = Object.getOwnPropertyNames(globalThis).filter(k =>
      /loader|amd|module|service|instantiation|di\\b/i.test(k));
    const out = { cands };
    out.hasVscodeLoader = !!(globalThis._VSCODE_FILE_ROOT);
    out.productJson = globalThis._VSCODE_PRODUCT_JSON ? {
      nameLong: globalThis._VSCODE_PRODUCT_JSON.nameLong,
      version: globalThis._VSCODE_PRODUCT_JSON.version,
      commit: (globalThis._VSCODE_PRODUCT_JSON.commit||'').slice(0,10),
    } : null;
    return out;
  })()`), null, 2));

  console.log('\n=== [3] DOM: Activity Bar / Views（找 Agents / Sessions 入口） ===');
  console.log(JSON.stringify(await c.eval(`(() => {
    const out = { total: document.querySelectorAll('*').length };
    // activity bar 项
    const ab = [...document.querySelectorAll('.activitybar .action-label, .activitybar .action-item, .activitybar li')];
    out.activityBar = ab.map(e => ({
      label: (e.getAttribute('aria-label') || e.title || e.textContent || '').trim().slice(0, 60),
      id: e.id || e.getAttribute('data-action-id') || '',
    })).filter(x => x.label);
    // 所有含 agent/session/chat 的 class 名
    const cls = new Set();
    document.querySelectorAll('*').forEach(e => {
      const cc = typeof e.className === 'string' ? e.className : '';
      if (/agent|session|chat/i.test(cc)) cc.split(/\\s+/).forEach(x => { if (/agent|session|chat/i.test(x)) cls.add(x); });
    });
    out.agentClasses = [...cls].slice(0, 40);
    return out;
  })()`), null, 2));

  console.log('\n=== [4] IndexedDB 数据库列表（VS Code 状态所在） ===');
  console.log(JSON.stringify(await c.eval(`(async () => {
    if (!indexedDB.databases) return { noApi: true };
    const dbs = await indexedDB.databases();
    return dbs.map(d => ({ name: d.name, version: d.version }));
  })()`, { awaitPromise: true }), null, 2));

  console.log('\n=== [5] 命令面板服务可达性（VSCode commands） ===');
  console.log(JSON.stringify(await c.eval(`(() => {
    // 通过 DOM 里的命令注册中心探测
    const anyWin = window;
    const keys = Object.getOwnPropertyNames(anyWin).filter(k => k.startsWith('__'));
    return { doubleUnderscoreKeys: keys.slice(0, 30) };
  })()`), null, 2));

  console.log('\n=== done ===');
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
