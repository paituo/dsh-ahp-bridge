#!/usr/bin/env node
/**
 * 用精确 aria-label 定位 agent picker（"选取 Agent 模式，交互式"）并展开，
 * 看是否出现 5 个 preset。
 */
import { spawn } from "node:child_process";
const CDP = process.argv[2] || "9333";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsEval(wsUrl, expr, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pend = new Map();
    const timer = setTimeout(() => { try { ws.close(); } catch {} ; resolve({ __timeout: true }); }, timeoutMs);
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: ++id, method: "Runtime.enable" }));
      const myId = ++id; pend.set(myId, (v) => { clearTimeout(timer); resolve(v); ws.close(); });
      ws.send(JSON.stringify({ id: myId, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
    };
    ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) pend.get(m.id)(m.result?.result?.value ?? m.result); } catch {} };
    ws.onerror = () => { clearTimeout(timer); resolve({ __err: "ws" }); };
  });
}

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  let W = list.find((x) => /sessions/i.test(x.url || ""));
  if (!W) {
    await new Promise((r) => { const p = spawn(process.execPath, ["test/cdp-agents-open.mjs"], { stdio: "inherit" }); p.on("exit", r); });
    await sleep(7000);
    W = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find((x) => /sessions/i.test(x.url || ""));
  }
  if (!W) { console.log("❌ 无 Agents 窗口"); process.exit(1); }
  W = W.webSocketDebuggerUrl;

  // 1) 精确定位 agent picker
  const s1 = await wsEval(W, `(() => {
    const all = [...document.querySelectorAll('[aria-label]')];
    const pk = all.find(e => /选取\\s*Agent\\s*模式|选取 Agent 模式/.test(e.getAttribute('aria-label')||''));
    return {
      found: !!pk,
      aria: pk ? pk.getAttribute('aria-label') : null,
      haspopup: pk ? pk.getAttribute('aria-haspopup') : null,
      html: pk ? pk.outerHTML.slice(0,400) : null,
      // 顺便列出所有 picker 类 aria
      allPickers: all.filter(e=>/选择|选取/.test(e.getAttribute('aria-label')||'')).map(e=>(e.getAttribute('aria-label')||'').slice(0,50)).slice(0,12)
    };
  })()`);
  console.log("=== [1] 精确 agent picker ===");
  console.log(JSON.stringify(s1, null, 2));

  // 2) 展开
  const s2 = await wsEval(W, `(async () => {
    const all = [...document.querySelectorAll('[aria-label]')];
    const pk = all.find(e => /选取\\s*Agent\\s*模式|选取 Agent 模式/.test(e.getAttribute('aria-label')||''));
    if (!pk) return { err: "picker not found" };
    pk.click();
    await new Promise(r=>setTimeout(r,1600));
    // 抓 dropdown（context-view / monaco-menu / quickinput）
    const cands = [...document.querySelectorAll('.context-view, .monaco-menu, .quick-input-widget, [role="menu"], [role="listbox"]')];
    const items = [];
    for (const c of cands) {
      for (const li of c.querySelectorAll('[role="menuitem"], [role="option"], .monaco-list-row, .action-item, .monaco-list-row *[class*="label"]')) {
        const tx = (li.textContent||'').trim();
        if (tx && tx.length < 80) items.push(tx);
      }
    }
    return { clicked: true, candCount: cands.length, items: [...new Set(items)].slice(0, 40) };
  })()`);
  console.log("\n=== [2] 展开后下拉项 ===");
  console.log(JSON.stringify(s2, null, 2));

  process.exit(0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
