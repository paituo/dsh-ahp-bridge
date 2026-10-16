#!/usr/bin/env node
/**
 * 一体化验证：进 DSH 会话 → 真实鼠标展开 agent picker → dump 项。
 * 判定：出现「标准模式/PTC 模式/极简模式/创作者模式/梁神」即落盘 agent 文件生效。
 */
const CDP = process.argv[2] || "9333";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sess() {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    let id = 0; const pend = new Map();
    ws.onopen = () => resolve({
      call: (method, params) => new Promise((res) => {
        const myId = ++id; pend.set(myId, res);
        ws.send(JSON.stringify({ id: myId, method, params }));
      }),
      close: () => ws.close(),
    });
    ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m); pend.delete(m.id); } } catch {} };
    setTimeout(() => { try { ws.close(); } catch {} ; resolve(null); }, 60000);
  });
}
let WS_URL = "";

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const w = list.find((x) => /sessions/i.test(x.url || ""));
  if (!w) { console.log("❌ 无 Agents 窗口"); process.exit(1); }
  WS_URL = w.webSocketDebuggerUrl;
  const c = await sess();
  if (!c) { console.log("❌ CDP 连接失败"); process.exit(1); }
  await c.call("Runtime.enable");

  async function ev(expr) {
    const r = await c.call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    return r?.result?.value;
  }

  // 1) 切到 DSH 会话（侧栏含"链路已验证"等）
  const s1 = await ev(`(async () => {
    const rows = [...document.querySelectorAll('.monaco-list-row, [role="option"]')];
    const hit = rows.find(e=>/链路已验证|自定义智能体正常|协议审计正常|CDP链路正常/.test(e.textContent||''));
    if (!hit) return { found:false, sample: rows.slice(0,10).map(e=>(e.textContent||'').trim().slice(0,30)) };
    hit.click();
    await new Promise(r=>setTimeout(r,3000));
    return { found:true, clicked:(hit.textContent||'').trim().slice(0,36) };
  })()`);
  console.log("=== [1] 切会话 ===", JSON.stringify(s1));

  // 2) 定位 agent picker 坐标
  const s2 = await ev(`(() => {
    const a=[...document.querySelectorAll('.chat-input-picker-item a.action-label[aria-haspopup="true"]')].find(x=>/^Agent$/i.test(x.getAttribute('aria-label')||''));
    if(!a) return null; const r=a.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
  })()`);
  console.log("=== [2] picker 坐标 ===", JSON.stringify(s2));
  if (!s2) { console.log("❌ 未找到 agent picker（可能不在会话输入视图）"); process.exit(1); }

  // 3) 真实鼠标点击展开
  for (const type of ["mousePressed", "mouseReleased"])
    await c.call("Input.dispatchMouseEvent", { type, x: s2.x, y: s2.y, button: "left", clickCount: 1 });
  await sleep(1800);

  // 4) dump dropdown 项
  const s4 = await ev(`(() => {
    const lists = [...document.querySelectorAll('.monaco-list')];
    const out = [];
    for (const L of lists) {
      const rows = [...L.querySelectorAll('.monaco-list-row')].map(r=>({ t:(r.textContent||'').trim().slice(0,60), aria:r.getAttribute('aria-label') }));
      if (rows.some(r=>/Agent|Ask|Plan|模式|梁神/.test(r.t))) out.push(rows);
    }
    return out;
  })()`);
  console.log("\n=== [3] agent picker 下拉项 ===");
  console.log(JSON.stringify(s4, null, 2));

  // 5) 判定
  const all = JSON.stringify(s4 || "");
  const hits = ["标准模式", "PTC 模式", "极简模式", "创作者模式", "梁神"].filter((n) => all.includes(n));
  console.log("\n=== [4] 判定 ===");
  console.log(hits.length ? `✅ 命中 ${hits.length}/5: ${hits.join(", ")}` : "❌ 未命中任何 DSH preset");
  c.close();
  process.exit(0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
