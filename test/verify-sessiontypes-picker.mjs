#!/usr/bin/env node
/** 验证 sessionTypes 暴露后，agent picker 是否出现 preset。 */
import { spawn } from "node:child_process";

const CDP = process.argv[2] || "9333";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsEval(wsUrl, expr) {
  // 用 node 内置 WebSocket（Node 22+ 全局可用）
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pend = new Map();
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: ++id, method: "Runtime.enable" }));
      const myId = ++id;
      pend.set(myId, resolve);
      ws.send(JSON.stringify({ id: myId, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
    };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.id && pend.has(m.id)) {
          const r = pend.get(m.id); pend.delete(m.id);
          r(m.result?.result?.value ?? m.result);
          if (pend.size === 0) { ws.close(); }
        }
      } catch {}
    };
    ws.onerror = (e) => reject(new Error("ws error"));
    setTimeout(() => { try { ws.close(); } catch {} ; resolve(null); }, 20000);
  });
}

async function targets() { return (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); }

(async () => {
  let t = await targets();
  let agentWin = t.find((x) => /sessions/i.test(x.url || ""));
  if (!agentWin) {
    console.log("未找到 Agents 窗口，尝试打开...");
    await new Promise((r) => { const p = spawn(process.execPath, ["test/cdp-agents-open.mjs"], { stdio: "inherit" }); p.on("exit", r); });
    await sleep(7000);
    t = await targets();
    agentWin = t.find((x) => /sessions/i.test(x.url || ""));
  }
  if (!agentWin) { console.log("❌ 无 Agents 窗口"); process.exit(1); }
  console.log("✅ Agents 窗口:", (agentWin.title || "").slice(0, 40));

  const res = await wsEval(agentWin.webSocketDebuggerUrl, `(async () => {
    const out = {};
    // 1) agent picker 当前显示
    const picker = document.querySelector('[class*="chat-agent-picker"]');
    out.pickerText = picker ? (picker.textContent||'').trim().slice(0,60) : null;
    // 2) 会话类型 picker
    const h = document.querySelector('[data-onboarding-id*="harnessPicker"]');
    out.harness = h ? (h.textContent||'').trim().slice(0,80) : null;
    // 3) 展开 agent picker
    if (picker) {
      const trigger = picker.querySelector('[aria-haspopup]') || picker.querySelector('a,button,[role=button]') || picker;
      trigger.click();
      await new Promise(r=>setTimeout(r,1400));
      const items = [...document.querySelectorAll('[role="menuitem"], .monaco-list-row, .action-item')].map(e=>(e.textContent||'').trim()).filter(Boolean);
      out.items = [...new Set(items)].slice(0, 25);
      // 关闭
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    }
    return out;
  })()`);
  console.log("\n=== agent picker 验证 ===");
  console.log(JSON.stringify(res, null, 2));
  process.exit(0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
