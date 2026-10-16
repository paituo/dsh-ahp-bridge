#!/usr/bin/env node
/**
 * 完整流程：新建会话 → 切会话类型为 DSH → 展开 agent picker → 选中 preset。
 * 全程真实鼠标事件；每步 dump 状态。
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

// 输入区 picker 快照
const EXPR_PICKERS = "(() => {"
  + "const out=[];"
  + "document.querySelectorAll('.chat-input-picker-item a.action-label[aria-haspopup=\"true\"], .chat-input-picker-item').forEach(el=>{"
  + "  const a = el.tagName==='A'?el:el.querySelector('a.action-label');"
  + "  const t=(el.textContent||'').trim().slice(0,40);"
  + "  const b=(a||el).getBoundingClientRect();"
  + "  if(b.width>0) out.push({t, al:(a&&a.getAttribute('aria-label'))||'', x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)});"
  + "});"
  + "return JSON.stringify(out);"
  + "})()";

// 浮层菜单项（monaco 下拉 / 快捷输入）
const EXPR_MENU = "(() => {"
  + "const out=[];"
  + "const sels=['.quick-input-list .monaco-list-row','.monaco-list-row','[role=\"menuitemcheckbox\"]','[role=\"menuitem\"]','.action-widget .action-item','.context-view .monaco-list-row'];"
  + "for(const s of sels){"
  + "  const els=document.querySelectorAll(s);"
  + "  els.forEach(el=>{const t=(el.textContent||'').trim(); const b=el.getBoundingClientRect(); if(t&&t.length<70&&b.width>0&&b.height>0) out.push({s,t,x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)});});"
  + "  if(out.length) break;"
  + "}"
  + "return JSON.stringify(out.slice(0,40));"
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

  // ---- Step 1: 新建会话（Ctrl+N 按钮）----
  const btn = JSON.parse(await ev("(() => {const el=document.querySelector('a.agent-sessions-compact-new'); if(!el)return 'null'; const b=el.getBoundingClientRect(); return JSON.stringify({x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)});})()"));
  if (btn && btn.x) {
    console.log("① 点『新会话』@(" + btn.x + "," + btn.y + ")");
    await clickAt(btn.x, btn.y);
    await sleep(2500);
  } else { console.log("① 未找到新会话按钮，沿用当前界面"); }

  let pickers = JSON.parse(await ev(EXPR_PICKERS));
  console.log("② 输入区 pickers:", JSON.stringify(pickers.map((p) => ({ t: p.t, al: p.al }))));

  // ---- Step 2: 切会话类型（找文本=本地 的 picker 并点开）----
  let typeP = pickers.find((p) => /本地/.test(p.t) || /本地/.test(p.al));
  if (typeP) {
    console.log("③ 点开会话类型 picker @(" + typeP.x + "," + typeP.y + ")");
    await clickAt(typeP.x, typeP.y);
    await sleep(900);
    const menu = JSON.parse(await ev(EXPR_MENU));
    console.log("③ 菜单项:", JSON.stringify(menu.map((m) => m.t)));
    const dsh = menu.find((m) => /DSH/i.test(m.t));
    if (dsh) { console.log("④ 选择 DSH: " + dsh.t); await clickAt(dsh.x, dsh.y); await sleep(3500); }
    else console.log("❌ 菜单无 DSH 项");
  } else { console.log("③ 未找到『本地』会话类型 picker（可能已在 DSH 会话中）"); }

  // ---- Step 3: 展开 agent picker ----
  pickers = JSON.parse(await ev(EXPR_PICKERS));
  console.log("⑤ 切换后 pickers:", JSON.stringify(pickers.map((p) => p.t)));
  let agentP = pickers.find((p) => /^Agent$/i.test(p.t) || /agent|智能体/i.test(p.al));
  if (!agentP) { console.log("❌ 未找到 agent picker"); ws.close(); process.exit(1); }
  console.log("⑥ 点开 agent picker @(" + agentP.x + "," + agentP.y + ")");
  const before = fs.existsSync(LOGFILE) ? fs.readFileSync(LOGFILE, "utf8").split("\n").length : 0;
  await clickAt(agentP.x, agentP.y);
  await sleep(1000);
  const menu2 = JSON.parse(await ev(EXPR_MENU));
  console.log("⑥ agent 下拉项:", JSON.stringify(menu2.map((m) => m.t)));

  const tgt = menu2.find((m) => m.t.includes(PRESET) || PRESET.includes(m.t));
  if (tgt) {
    console.log('⑦ 选中 "' + tgt.t + '" @(' + tgt.x + "," + tgt.y + ")");
    await clickAt(tgt.x, tgt.y);
    await sleep(3000);
  } else { console.log('❌ agent 下拉无 "' + PRESET + '"'); }

  // ---- 结果判据 ----
  const lines = fs.existsSync(LOGFILE) ? fs.readFileSync(LOGFILE, "utf8").split("\n") : [];
  const added = lines.slice(before).filter(Boolean);
  const setAgent = lines.filter((l) => /setAgent: session=/.test(l));
  console.log("\n──── 新增日志 ────");
  for (const l of added) console.log("  " + l.slice(0, 200));
  console.log("\n──── setAgent 回传 ────" + (setAgent.length ? " ✅ " + setAgent.length + " 条" : " ❌ 无"));
  for (const l of setAgent.slice(-5)) console.log("  " + l.slice(0, 220));

  const pickersAfter = JSON.parse(await ev(EXPR_PICKERS));
  console.log("\n最终 pickers:", JSON.stringify(pickersAfter.map((p) => p.t)));
  ws.close(); process.exit(0);
})();
