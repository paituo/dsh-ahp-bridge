#!/usr/bin/env node
/** 查 Agents 窗口的当前工作区/会话 cwd，判断 .github/agents 是否在其扫描范围。 */
const CDP = process.argv[2] || "9333";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let WS_URL = "";
function sess() {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    let id = 0; const pend = new Map();
    ws.onopen = () => resolve({
      call: (m, p) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); }),
      close: () => ws.close(),
    });
    ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m); pend.delete(m.id); } } catch {} };
    setTimeout(() => { try { ws.close(); } catch {} ; resolve(null); }, 45000);
  });
}
(async () => {
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const w = list.find((x) => /sessions/i.test(x.url || ""));
  if (!w) { console.log("no agents win"); process.exit(1); }
  WS_URL = w.webSocketDebuggerUrl;
  const c = await sess();
  await c.call("Runtime.enable");
  const ev = async (e) => (await c.call("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;
  console.log(JSON.stringify(await ev(`(() => ({
    title: document.title,
    // 侧栏工作区名
    workspaceLabels: [...document.querySelectorAll('[aria-label*="工作区"]')].map(e=>e.getAttribute('aria-label')).slice(0,5),
    // 抓可见文本里的工作区/路径线索
    textHints: [...document.querySelectorAll('*')].map(e=>e.getAttribute&&e.getAttribute('title')).filter(t=>t&&/\\\\\\\\|\\//.test(t)&&t.length<120).slice(0,10),
    // 侧栏顶部 label
    sidebarTop: (document.querySelector('.composite-bar, .part.titlebar')||{}).textContent?.slice(0,100) || null,
  }))()`), null, 2));
  c.close(); process.exit(0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
