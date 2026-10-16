#!/usr/bin/env node
/**
 * 深挖：agent picker 的下拉项从哪来。
 * 步骤：
 *  1) 打开 Agents 窗口
 *  2) 点侧栏一个 DSH 会话（"请只回复四个字：..." 之类）
 *  3) 展开 agent picker，精确抓 dropdown 容器内的项
 *  4) 同时打印 provider 列表（若可从 window 拿到）
 */
import { spawn } from "node:child_process";
const CDP = process.argv[2] || "9333";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsEval(wsUrl, expr, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pend = new Map();
    const timer = setTimeout(() => { try { ws.close(); } catch {} ; resolve({ __timeout: true }); }, timeoutMs);
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: ++id, method: "Runtime.enable" }));
      const myId = ++id; pend.set(myId, (v) => { clearTimeout(timer); resolve(v); ws.close(); });
      ws.send(JSON.stringify({ id: myId, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
    };
    ws.onmessage = (ev) => {
      try { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) pend.get(m.id)(m.result?.result?.value ?? m.result); } catch {}
    };
    ws.onerror = () => { clearTimeout(timer); resolve({ __err: "ws" }); };
  });
}

(async () => {
  let t = (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json ? await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json() : null;
  let agentWin = t.find((x) => /sessions/i.test(x.url || ""));
  if (!agentWin) {
    await new Promise((r) => { const p = spawn(process.execPath, ["test/cdp-agents-open.mjs"], { stdio: "inherit" }); p.on("exit", r); });
    await sleep(7000);
    t = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    agentWin = t.find((x) => /sessions/i.test(x.url || ""));
  }
  if (!agentWin) { console.log("❌ 无 Agents 窗口"); process.exit(1); }
  console.log("✅ Agents 窗口:", (agentWin.title || "").slice(0, 40));
  const W = agentWin.webSocketDebuggerUrl;

  // 步骤 A：列出侧栏会话项 + 找到当前 agent picker 的完整 DOM
  const a = await wsEval(W, `(() => {
    const out = {};
    const pk = document.querySelector('[class*="chat-agent-picker"]');
    out.pickerOuterHTML = pk ? pk.outerHTML.slice(0, 600) : null;
    // 找所有可能的下拉触发器
    out.triggers = [...document.querySelectorAll('[aria-haspopup]')].map(e=>({
      cls: e.className.slice(0,70), aria: e.getAttribute('aria-label'), expanded: e.getAttribute('aria-expanded')
    })).slice(0, 15);
    return out;
  })()`);
  console.log("\n=== [A] picker DOM ===");
  console.log(JSON.stringify(a, null, 2).slice(0, 2000));

  // 步骤 B：切到一个 DSH 会话（点侧栏含"链路已验证"的项）
  const b = await wsEval(W, `(async () => {
    const rows = [...document.querySelectorAll('.monaco-list-row, [role="option"]')];
    const hit = rows.find(e=>/链路已验证|自定义智能体正常|协议审计正常|CDP链路正常/.test(e.textContent||''));
    if (!hit) return { found:false, candidates: rows.slice(0,12).map(e=>(e.textContent||'').trim().slice(0,40)) };
    hit.click();
    await new Promise(r=>setTimeout(r,3000));
    const pk = document.querySelector('[class*="chat-agent-picker"]');
    return { found:true, clicked:(hit.textContent||'').trim().slice(0,40), pickerText: pk?(pk.textContent||'').trim().slice(0,60):null };
  })()`);
  console.log("\n=== [B] 切换 DSH 会话 ===");
  console.log(JSON.stringify(b, null, 2));

  // 步骤 C：展开 picker
  const c = await wsEval(W, `(async () => {
    const pk = document.querySelector('[class*="chat-agent-picker"]');
    if (!pk) return { err: "no picker" };
    const trg = pk.querySelector('[aria-haspopup]') || pk.querySelector('a,button,[role=button]') || pk;
    trg.click();
    await new Promise(r=>setTimeout(r,1500));
    // 精确找 dropdown：monaco 的 context-view / .monaco-menu / [role=menu]
    const menus = [...document.querySelectorAll('.monaco-menu, [role="menu"], .context-view, .monaco-list')];
    const items = [];
    for (const m of menus) {
      for (const li of m.querySelectorAll('[role="menuitem"], .monaco-list-row, .action-item')) {
        const tx = (li.textContent||'').trim();
        if (tx) items.push(tx.slice(0,60));
      }
    }
    return { clicked: true, menuCount: menus.length, items: [...new Set(items)].slice(0, 30),
             pkAfter: pk ? (pk.textContent||'').trim().slice(0,60) : null };
  })()`);
  console.log("\n=== [C] 展开后下拉项 ===");
  console.log(JSON.stringify(c, null, 2));

  process.exit(0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
