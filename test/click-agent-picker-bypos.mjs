#!/usr/bin/env node
/**
 * 直接按坐标点击 DSH 会话的 agent picker（x=695,y=850），展开后 dump 浮层项并选 preset。
 * 不依赖 aria-label 匹配（避免编码/时序问题）；坐标由 probe-agent-picker-precise 得出。
 */
const PORT = process.argv[2] || "9333";
const X = Number(process.argv[3] || 695);
const Y = Number(process.argv[4] || 850);
const PRESET = process.argv[5] || "创作者模式";
const LOGFILE = "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30/temp/dsh-ahp-bridge/bridge/temp/inject-bridge.log";
import fs from "node:fs";

const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
const pg = list.filter((p) => p.type === "page").find((p) => /^Agent/i.test(p.title || ""));
const ws = new WebSocket(pg.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data.toString()); if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Runtime.enable");
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mouse = (type, x, y, cc = 0) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: cc, buttons: type === "mousePressed" ? 1 : 0 });
const clickAt = async (x, y) => { await mouse("mouseMoved", x, y); await mouse("mousePressed", x, y, 1); await mouse("mouseReleased", x, y, 1); };

// 用 elementFromPoint 扫描浮层行（覆盖整个下半屏）
const EXPR_FLOAT = "(() => {"
  + "const out=[]; const seen=new Set();"
  + "for(let y=560;y<=880;y+=12){ for(let x=360;x<=1180;x+=24){"
  + "  const el=document.elementFromPoint(x,y); if(!el) continue;"
  + "  const row=el.closest('.monaco-list-row,[role=\"menuitemcheckbox\"],[role=\"menuitem\"],.action-widget .action-item,.quick-input-list .monaco-list-row,.context-view .monaco-list-row');"
  + "  if(!row) continue;"
  + "  const t=(row.textContent||'').trim(); if(!t||t.length>60) continue;"
  + "  const b=row.getBoundingClientRect(); const k=t+'@'+Math.round(b.y);"
  + "  if(seen.has(k)) continue; seen.add(k);"
  + "  out.push({t, x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)});"
  + "}}"
  + "return JSON.stringify(out);"
  + "})()";

const before = fs.existsSync(LOGFILE) ? fs.readFileSync(LOGFILE, "utf8").split("\n").length : 0;

console.log("① 点击 agent picker @(" + X + "," + Y + ")");
await clickAt(X, Y);
await sleep(1200);

const floats = JSON.parse(await ev(EXPR_FLOAT));
console.log("② 浮层项:", JSON.stringify(floats.map((f) => f.t)));

const tgt = floats.find((f) => f.t.includes(PRESET) || PRESET.includes(f.t));
if (!tgt) { console.log('❌ 浮层无 "' + PRESET + '"'); ws.close(); process.exit(1); }
console.log('③ 点选 "' + tgt.t + '" @(' + tgt.x + "," + tgt.y + ")");
await clickAt(tgt.x, tgt.y);
await sleep(3000);

const lines = fs.existsSync(LOGFILE) ? fs.readFileSync(LOGFILE, "utf8").split("\n") : [];
const added = lines.slice(before).filter(Boolean);
const setAgent = lines.filter((l) => /setAgent: session=/.test(l));
console.log("\n──── 新增日志 ────");
for (const l of added) console.log("  " + l.slice(0, 220));
console.log("\n──── setAgent 回传 ────" + (setAgent.length ? " ✅ " + setAgent.length + " 条" : " ❌ 无"));
for (const l of setAgent.slice(-6)) console.log("  " + l.slice(0, 240));
ws.close(); process.exit(0);
