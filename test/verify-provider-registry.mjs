// verify-provider-registry.mjs — 从 renderer 侧直接查 sessionsProvidersService 注册表内容
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
      expression: `(() => { try { return (${expr}); } catch (e) { return { __err: String(e && (e.stack||e.message) || e) }; } })()`,
      awaitPromise: !!opts.awaitPromise, returnByValue: true, timeout: 15000,
    });
    if (r.__timeout) return { __timeout: true };
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text || JSON.stringify(r.result.exceptionDetails).slice(0,300) };
    return r.result?.result?.value;
  }
}

async function main() {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  console.log('== targets ==');
  list.forEach(t => console.log(' ', t.type, '|', (t.title||'').slice(0,40), '|', (t.url||'').slice(0,80)));
  const sess = list.find((t) => /sessions/.test(t.url));
  if (!sess) { console.error('!! 无 sessions.html 窗口'); process.exit(1); }
  const c = await new CDP(sess.webSocketDebuggerUrl).connect();
  await c.send('Runtime.enable');

  console.log('\n== [1] 全局里有没有 sessionsProvidersService 相关符号 ==');
  console.log(JSON.stringify(await c.eval(`(() => {
    const keys = Object.keys(globalThis).filter(k => /session|provider|agent/i.test(k));
    return { globalKeys: keys.slice(0,40), hasRequire: typeof require, hasDefine: typeof define };
  })()`), null, 2));

  console.log('\n== [2] 从 DOM 找 provider 相关 data 属性 ==');
  console.log(JSON.stringify(await c.eval(`(() => {
    const seen = new Set(); const out = [];
    document.querySelectorAll('[data-onboarding-id]').forEach(e => {
      const v = e.getAttribute('data-onboarding-id') || '';
      if (!seen.has(v)) { seen.add(v); out.push(v); }
    });
    return out.slice(0,60);
  })()`), null, 2));

  console.log('\n== [3] 抓所有含 dsh / agenthost / agent-host 的 DOM 属性 ==');
  console.log(JSON.stringify(await c.eval(`(() => {
    const out = [];
    document.querySelectorAll('*').forEach(e => {
      for (const a of e.attributes) {
        if (/dsh|agenthost|agent-host/i.test(a.value)) { out.push({ tag:e.tagName, attr:a.name, val:a.value.slice(0,140) }); }
      }
    });
    return out.slice(0,80);
  })()`), null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
