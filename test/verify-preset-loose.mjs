#!/usr/bin/env node
/** 宽松抓取 agent picker 下拉项（不预设筛选条件，全量 dump 可见浮层文本）。 */
const CDP = process.argv[2] || "9333";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let WS_URL = "";
function sess() {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    let id = 0; const pend = new Map();
    ws.onopen = () => resolve({
      call: (method, params) => new Promise((res) => { const myId = ++id; pend.set(myId, res); ws.send(JSON.stringify({ id: myId, method, params })); }),
      close: () => ws.close(),
    });
    ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m); pend.delete(m.id); } } catch {} };
    setTimeout(() => { try { ws.close(); } catch {} ; resolve(null); }, 60000);
  });
}
(async () => {
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const w = list.find((x) => /sessions/i.test(x.url || ""));
  WS_URL = w.webSocketDebuggerUrl;
  const c = await sess();
  await c.call("Runtime.enable");
  const ev = async (e) => (await c.call("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;

  // 确保在 DSH 会话
  await ev(`(async () => {
    const rows=[...document.querySelectorAll('.monaco-list-row')];
    const hit=rows.find(e=>/链路已验证|自定义智能体正常|协议审计正常|CDP链路正常/.test(e.textContent||''));
    if(hit){ hit.click(); await new Promise(r=>setTimeout(r,2500)); }
    return 1;
  })()`);

  const pos = await ev(`(() => { const a=[...document.querySelectorAll('.chat-input-picker-item a.action-label[aria-haspopup="true"]')].find(x=>/^Agent$/i.test(x.getAttribute('aria-label')||'')); if(!a)return null; const r=a.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()`);
  if (!pos) { console.log("❌ 无 picker"); process.exit(1); }
  for (const type of ["mousePressed", "mouseReleased"]) await c.call("Input.dispatchMouseEvent", { type, x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  await sleep(1500);

  // 宽松 dump：所有含 monaco-list-row 的容器 + 所有可见浮层
  const dump = await ev(`(() => {
    const out = { lists: [], overlays: [] };
    for (const L of document.querySelectorAll('.monaco-list')) {
      const rows = [...L.querySelectorAll('.monaco-list-row')].map(r=>(r.textContent||'').trim()).filter(Boolean);
      if (rows.length) out.lists.push(rows);
    }
    for (const o of document.querySelectorAll('.context-view, .monaco-menu, .quick-input-widget')) {
      const t = (o.textContent||'').trim();
      if (t) out.overlays.push({ cls:(o.className||'').toString().slice(0,50), text: t.slice(0,500) });
    }
    return out;
  })()`);
  console.log(JSON.stringify(dump, null, 2).slice(0, 3000));
  const all = JSON.stringify(dump || "");
  const hits = ["标准模式", "PTC 模式", "极简模式", "创作者模式", "梁神"].filter((n) => all.includes(n));
  console.log("\n=== 判定 ===", hits.length ? `✅ 命中 ${hits.length}/5: ${hits.join(", ")}` : "❌ 未命中");
  c.close(); process.exit(0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
