#!/usr/bin/env node
/**
 * ★ 验证「选中 preset → setAgent 回传」链路（2026-10-11 路线 B 收尾）。
 *
 * 判据（可观测，不靠猜）：
 *   1. 打开 Agents 窗口的 agent picker，dump 下拉项（确认 5 个 preset 在内）
 *   2. 用**真实鼠标事件**点选其中一个 preset（el.click() 无效，monaco 监听 mousedown）
 *   3. 读注入侧文件日志 temp/inject-bridge.log，找 setAgent: session=... agent=...
 *      —— 有 ⇒ 回传接通；无 ⇒ 回传断开（需在 bundle 里找真正的 _setAgent 调用点）
 *
 * 用法：node test/verify-setagent-roundtrip.mjs [port] [presetName]
 */
const PORT = process.argv[2] || "9333";
const WANT = process.argv[3] || "创作者模式";
const LOGFILE = "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30/temp/dsh-ahp-bridge/bridge/temp/inject-bridge.log";
import fs from "node:fs";

async function pickPage() {
  const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
  const pages = list.filter((p) => p.type === "page");
  return pages.find((p) => /^Agent/i.test(p.title || "")) || pages[0];
}

function connect(wsUrl) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pend = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data.toString());
      if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    };
    ws.onopen = () => resolve({
      ws,
      send: (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }),
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXPR_FINDER = "(() => {"
  + "const trig = [...document.querySelectorAll('a.action-label[aria-haspopup=\"true\"]')]"
  + ".map(a => ({ a, label: a.getAttribute('aria-label') || '', text: (a.textContent||'').trim() }))"
  + ".find(x => /agent|\u667a\u80fd\u4f53/i.test(x.label) || /agent|\u667a\u80fd\u4f53/i.test(x.text));"
  + "if (!trig) { const all=[...document.querySelectorAll('a.action-label[aria-haspopup=\"true\"]')].map(a=>a.getAttribute('aria-label')||(a.textContent||'').trim().slice(0,20)); return JSON.stringify({ ok:false, all }); }"
  + "const r = trig.a.getBoundingClientRect();"
  + "return JSON.stringify({ ok:true, label: trig.label, text: trig.text, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });"
  + "})()";

const EXPR_ITEMS = "(() => {"
  + "const sel = ['.chat-mode-picker-item', '.action-widget', '.monaco-list-row', '.monaco-menu .action-item', '[role=\"menuitem\"]'];"
  + "const out = [];"
  + "for (const s of sel) {"
  + "  document.querySelectorAll(s).forEach(el => {"
  + "    const t = (el.textContent || '').trim();"
  + "    if (t && t.length < 60) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) out.push({ sel: s, text: t, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }); }"
  + "  });"
  + "  if (out.length) break;"
  + "}"
  + "return JSON.stringify(out);"
  + "})()";

(async () => {
  const pg = await pickPage();
  console.log("target:", pg.title, "|", pg.url.slice(0, 70));
  const { ws, send } = await connect(pg.webSocketDebuggerUrl);
  await send("Runtime.enable");

  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };

  // ---- 1) 找 agent picker 触发器 -------------------------------------------------
  let f = JSON.parse(await ev(EXPR_FINDER));
  if (!f.ok) { console.log("❌ 未找到 agent picker 触发器。现有 picker:", JSON.stringify(f.all)); ws.close(); process.exit(1); }
  console.log('✅ 触发器: label="' + f.label + '" text="' + f.text + '" @(' + f.x + "," + f.y + ")");

  // ---- 2) 真实鼠标点击展开 -------------------------------------------------------
  const mouse = async (type, x, y, clickCount = 0) => {
    await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount, buttons: type === "mousePressed" ? 1 : 0 });
  };
  await mouse("mouseMoved", f.x, f.y);
  await mouse("mousePressed", f.x, f.y, 1);
  await mouse("mouseReleased", f.x, f.y, 1);
  await sleep(800);

  // ---- 3) dump 下拉项 -----------------------------------------------------------
  const items = JSON.parse(await ev(EXPR_ITEMS));
  console.log("下拉项:", JSON.stringify(items.map((i) => i.text)));

  const target = items.find((i) => i.text.includes(WANT) || WANT.includes(i.text));
  if (!target) { console.log('❌ 下拉里没有 "' + WANT + '"'); ws.close(); process.exit(1); }
  console.log('🎯 目标项: "' + target.text + '" @(' + target.x + "," + target.y + ")");

  // ---- 4) 记录日志基线 → 点选 → 看是否新增 setAgent 行 ---------------------------
  const before = fs.existsSync(LOGFILE) ? fs.readFileSync(LOGFILE, "utf8").split("\n").length : 0;
  await mouse("mouseMoved", target.x, target.y);
  await mouse("mousePressed", target.x, target.y, 1);
  await mouse("mouseReleased", target.x, target.y, 1);
  await sleep(2500);

  const lines = fs.existsSync(LOGFILE) ? fs.readFileSync(LOGFILE, "utf8").split("\n") : [];
  const added = lines.slice(before).filter(Boolean);
  const setAgentLines = lines.filter((l) => /setAgent: session=/.test(l));

  console.log("\n──── 点选后新增日志 ────");
  for (const l of added) console.log("  " + l.slice(0, 200));

  console.log("\n──── 是否有 setAgent 回传 ────");
  if (setAgentLines.length) {
    console.log("✅ 命中 " + setAgentLines.length + " 条：");
    for (const l of setAgentLines.slice(-5)) console.log("  " + l.slice(0, 220));
  } else {
    console.log("❌ 日志里**没有任何** setAgent 行 ⇒ 选中未回传到 provider 覆写层。");
  }

  const after = JSON.parse(await ev(EXPR_FINDER));
  console.log("\n触发器文本（点选后）:", after.text, "| label:", after.label);

  ws.close();
  process.exit(0);
})();
