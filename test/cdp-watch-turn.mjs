// cdp-watch-turn.mjs — 观察当前会话的 turn 状态与真实消息 DOM
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
}

async function main() {
  const list = await (await fetch(`${BASE}/json/list`)).json();
  const sess = list.find((t) => /sessions/.test(t.url));
  const c = await new CDP(sess.webSocketDebuggerUrl).connect();
  await c.send('Runtime.enable');

  console.log('=== 真实消息 DOM 结构 ===');
  console.log(JSON.stringify(await c.eval(`(() => {
    const out = { byClass: {} };
    const probes = ['message','chat','turn','request','response','tool','reasoning','thought','diff','markdown','content'];
    for (const p of probes) {
      const els = document.querySelectorAll('[class*="'+p+'"]');
      if (els.length) {
        out.byClass[p] = {
          n: els.length,
          sample: [...els].slice(0, 3).map(e => ({
            cls: (typeof e.className === 'string' ? e.className : '').slice(0, 70),
            txt: (e.innerText || '').trim().replace(/\\s+/g,' ').slice(0, 120),
          })),
        };
      }
    }
    return out;
  })()`), null, 2));

  console.log('\n=== 主内容区完整文本（看是否有我的消息与回复） ===');
  console.log(JSON.stringify(await c.eval(`(() => {
    const main = document.querySelector('[class*="agent-sessions-content"], .monaco-list-row.list_id_3, main, [role=main]');
    const t = main ? main.innerText : document.body.innerText;
    return (t || '').split('\\n').map(s=>s.trim()).filter(Boolean).slice(0, 60);
  })()`), null, 2));

  console.log('\n=== 输入框状态（是否还在忙/是否有 stop 按钮） ===');
  console.log(JSON.stringify(await c.eval(`(() => ({
    stopBtn: !!document.querySelector('[aria-label*="停止"], [class*="codicon-stop"], [class*="debug-stop"]'),
    loading: !!document.querySelector('[class*="loading"], [class*="spinner"]'),
    sendBtnDisabled: (() => { const b = document.querySelector('[aria-label*="发送"], [class*="send-button"]'); return b ? b.disabled : null; })(),
    allAria: [...document.querySelectorAll('[aria-label]')].map(e=>e.getAttribute('aria-label')).filter(l => l && /发送|停止|Send|Stop|取消/i.test(l)).slice(0,10),
  }))()`), null, 2));

  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
