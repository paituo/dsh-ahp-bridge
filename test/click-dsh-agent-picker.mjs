#!/usr/bin/env node
/**
 * 选中 DSH 会话的 agent picker（aria-label="选择模式，Agent"）→ 展开 → 点 preset。
 * 全真实鼠标事件 + 文件日志判据。
 */
const PORT = process.argv[2] || "9333";
const PRESET = process.argv[3] || "创作者模式";
const LOGFILE = "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30/temp/dsh-ahp-bridge/bridge/temp/inject-bridge.log";
import fs from "node:fs";

function connect(wsUrl) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pend = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data.toString()); if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    ws.onopen = () => resolve({ ws, send: (m, p) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); }) });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 所有可见的浮层项（用 elementFromPoint 反查，最可靠）
const EXPR_FLOAT = "(() => {"
  + "const out=[]; const seen=new Set();"
  + "const pts=[];"
  + "for(let y=500;y<=880;y+=14){ for(let x=300;x<=1100;x+=30) pts.push([x,y]); }"
  + "for(const [x,y] of pts){"
  + "  const el=document.elementFromPoint(x,y); if(!el) continue;"
  + "  let row=el.closest('.monaco-list-row,[role=\"menuitemcheckbox\"],[role=\"menuitem\"],.action-widget .action-item,.quick-input-list .monaco-list-row');"
  + "  if(!row) continue;"
  + "  const t=(row.textContent||'').trim(); if(!t||t.length>60) continue;"
  + "  const k=t+'@'+Math.round(row.getBoundingClientRect().y/8);"
  + "  if(seen.has(k)) continue; seen.add(k);"
  + "  const b=row.getBoundingClientRect();"
  + "  out.push({t, x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)});"
  + "}"
  + "return JSON.stringify(out);"
  + "})()";

(async () => {
  const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
  const pg = list.filter((p) => p.type === "page").find((p) => /^Agent/i.test(p.title || ""));
  const { ws, send } = await connect(pg.webSocketDebuggerUrl);
  await send("Runtime.enable");
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };
  const mouse = async (type, x, y, cc = 0) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: cc, buttons: type === "mousePressed" ? 1 : 0 });
  const clickAt = async (x, y) => { await mouse("mouseMoved", x, y); await mouse("mousePressed", x, y, 1); await mouse("mouseReleased", x, y, 1); };

  // 找 aria-label 含 "选择模式" 的（取最右 = DSH 会话那个）
  const trigs = JSON.parse(await ev("(() => {"
    + "const out=[];"
    + "document.querySelectorAll('a.action-label[aria-haspopup=\"true\"]').forEach(el=>{"
    + "  const al=el.getAttribute('aria-label')||'';"
    + "  if(al.indexOf('\u9009\u62e9\u6a21\u5f0f') >= 0){ const b=el.getBoundingClientRect(); out.push({al,t:(el.textContent||'').trim(),x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}); }"
    + "});"
    + "return JSON.stringify(out);"
    + "})()"));
  console.log("找到 agent picker 触发器:", JSON.stringify(trigs));
  if (!trigs.length) { console.log("❌ 无"); ws.close(); process.exit(1); }
  const trig = trigs[trigs.length - 1]; // 取最右（DSH 会话）
  console.log("使用触发器:", JSON.stringify(trig));

  const before = fs.existsSync(LOGFILE) ? fs.readFileSync(LOGFILE, "utf8").split("\n").length : 0;

  await clickAt(trig.x, trig.y);
  await sleep(1000);
  const floats = JSON.parse(await ev(EXPR_FLOAT));
  console.log("\n浮层项:", JSON.stringify(floats.map((f) => f.t)));

  const tgt = floats.find((f) => f.t.includes(PRESET) || PRESET.includes(f.t));
  if (!tgt) { console.log('❌ 浮层无 "' + PRESET + '"'); ws.close(); process.exit(1); }
  console.log('🎯 点选 "' + tgt.t + '" @(' + tgt.x + "," + tgt.y + ")");
  await clickAt(tgt.x, tgt.y);
  await sleep(3000);

  const lines = fs.existsSync(LOGFILE) ? fs.readFileSync(LOGFILE, "utf8").split("\n") : [];
  const added = lines.slice(before).filter(Boolean);
  const setAgent = lines.filter((l) => /setAgent: session=/.test(l));
  console.log("\n──── 新增日志 ────");
  for (const l of added) console.log("  " + l.slice(0, 220));
  console.log("\n──── setAgent 回传 ────" + (setAgent.length ? " ✅ " + setAgent.length + " 条" : " ❌ 无"));
  for (const l of setAgent.slice(-5)) console.log("  " + l.slice(0, 240));

  const after = JSON.parse(await ev("(() => {"
    + "const out=[];"
    + "document.querySelectorAll('a.action-label[aria-haspopup=\"true\"]').forEach(el=>{const al=el.getAttribute('aria-label')||''; if(al.indexOf('\u9009\u62e9\u6a21\u5f0f')>=0){out.push((el.textContent||'').trim()+'|'+al);}});"
    + "return JSON.stringify(out);"
    + "})()"));
  console.log("\n点选后触发器文本:", JSON.stringify(after));
  ws.close(); process.exit(0);
})();
