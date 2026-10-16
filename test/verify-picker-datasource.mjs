#!/usr/bin/env node
/**
 * 判决性验证：agent picker 的真实数据源到底是哪条？
 *
 * 假设 H1：picker ← customizationHarnessService._customAgentsService.getCustomAgents
 *          → _getAHSProvider(session) → provider.getCustomAgents(sessionId)   [我们注入的]
 * 假设 H2：picker ← agentHost harness.itemProvider.provideCustomAgents
 *          → promptsService.getCustomAgents(e).filter(rw(sessionTypes, providerId))  [VS Code 自己的 prompt 发现]
 *
 * 方法：开 Agents 窗口 → 找 agent picker → 展开 → 枚举选项；同时数桥端 agent/list 被调用次数增量。
 * 若展开时桥端 agent/list 无增量 ⇒ 走 H2（不经过我们的 provider）。
 */
import { spawn, execSync } from "node:child_process";
import net from "node:net";

const CDP = process.argv[2] || "9333";
const LOG = process.argv[3] || "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${CDP}/json/list`);
  return res.json();
}

/** 极简 CDP 客户端 */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(wsUrl);
    const key = Buffer.from(`${Math.random()}`).toString("base64");
    const req = `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
    const sock = net.connect(Number(url.port), url.hostname, () => sock.write(req));
    let handshaken = false, buf = Buffer.alloc(0);
    const pending = new Map();
    let id = 0;
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!handshaken) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx < 0) return;
        handshaken = true;
        buf = buf.subarray(idx + 4);
        resolve(api);
      }
      // 解析帧
      while (buf.length >= 2) {
        const b1 = buf[1], masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f, off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (masked) off += 4;
        if (buf.length < off + len) break;
        const payload = buf.subarray(off, off + len).toString();
        buf = buf.subarray(off + len);
        try {
          const msg = JSON.parse(payload);
          if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
        } catch {}
      }
    });
    sock.on("error", reject);
    function send(method, params = {}) {
      const myId = ++id;
      const body = JSON.stringify({ id: myId, method, params });
      const b = Buffer.from(body);
      const mask = Buffer.from([1, 2, 3, 4]);
      const head = Buffer.alloc(2 + mask.length + b.length);
      head[0] = 0x81;
      if (b.length < 126) { head[1] = 0x80 | b.length; }
      else { head[1] = 0x80 | 126; head.writeUInt16BE(b.length, 2); }
      mask.copy(head, 2);
      for (let i = 0; i < b.length; i++) b[i] ^= mask[i % 4];
      b.copy(head, 2 + mask.length);
      sock.write(head);
      return new Promise((r) => pending.set(myId, r));
    }
    const api = { send, close: () => sock.end(), raw: sock };
  });
}

async function evalJs(conn, expression) {
  const r = await conn.send("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
  return r.result?.result?.value;
}

function countLog(file, needle) {
  if (!file) return -1;
  try {
    const out = execSync(`grep -c "${needle}" "${file}" 2>/dev/null || echo 0`).toString().trim();
    return Number(out) || 0;
  } catch { return -1; }
}

(async () => {
  const targets = await listTargets();
  console.log("=== targets ===");
  targets.forEach((t, i) => console.log(`[${i}] type=${t.type} title="${t.title?.slice(0, 60)}" url=${(t.url || "").slice(0, 90)}`));

  let target = targets.find((t) => /sessions/i.test(t.url || ""));
  if (!target) {
    console.log("\n⚠️ 未找到 Agents 窗口，尝试打开...");
    await new Promise((resolve) => {
      const p = spawn(process.execPath, ["test/cdp-agents-open.mjs"], { stdio: "inherit" });
      p.on("exit", resolve);
    });
    await sleep(6000);
    const t2 = await listTargets();
    target = t2.find((t) => /sessions/i.test(t.url || ""));
    if (!target) { console.log("❌ 仍无 Agents 窗口"); process.exit(1); }
  }
  console.log(`\n✅ 目标: ${target.title} | ${target.url.slice(0, 80)}`);

  const conn = await connect(target.webSocketDebuggerUrl);
  await conn.send("Runtime.enable");

  // --- 1) 找 agent picker ---
  const probe = await evalJs(conn, `(() => {
    const out = {};
    const picker = document.querySelector('.chat-agent-picker-item, [class*="chat-agent-picker"]');
    out.found = !!picker;
    if (picker) {
      out.tag = picker.tagName;
      out.cls = picker.className;
      out.text = (picker.textContent||'').trim().slice(0,60);
      const inner = picker.querySelector('[aria-haspopup]') || picker;
      out.haspopup = inner.getAttribute('aria-haspopup');
      out.expanded = inner.getAttribute('aria-expanded');
      out.aria = inner.getAttribute('aria-label') || picker.getAttribute('aria-label');
    }
    // 会话类型 picker
    const harness = document.querySelector('[data-onboarding-id*="harnessPicker"]');
    out.harness = harness ? (harness.textContent||'').trim().slice(0,80) : null;
    // 侧栏可见会话
    const items = [...document.querySelectorAll('[role="option"], .monaco-list-row')].map(e=>(e.textContent||'').trim().slice(0,50)).filter(Boolean);
    out.sidebarItems = items.slice(0, 15);
    return out;
  })()`);
  console.log("\n=== [1] agent picker 状态 ===");
  console.log(JSON.stringify(probe, null, 2));

  const before = countLog(LOG, "agent/list");
  console.log(`\n=== [2] 桥端 agent/list 调用次数(前) = ${before} ===`);

  // --- 3) 试着点开 picker 并枚举 ---
  const opened = await evalJs(conn, `(async () => {
    const picker = document.querySelector('.chat-agent-picker-item, [class*="chat-agent-picker"]');
    if (!picker) return { err: "no picker" };
    const clickable = picker.querySelector('[aria-haspopup]') || picker.querySelector('a,button,[role="button"]') || picker;
    clickable.click();
    await new Promise(r=>setTimeout(r, 1200));
    // 枚举所有可见的菜单项
    const items = [...document.querySelectorAll('[role="menuitem"], .monaco-list-row, .action-item')]
      .map(e=>(e.textContent||'').trim().slice(0,60)).filter(Boolean);
    return { clicked: true, items: [...new Set(items)].slice(0, 30) };
  })()`);
  console.log("\n=== [3] 展开 picker 后选项 ===");
  console.log(JSON.stringify(opened, null, 2));

  await sleep(1500);
  const after = countLog(LOG, "agent/list");
  console.log(`\n=== [4] 桥端 agent/list 调用次数(后) = ${after} | 增量 = ${after - before} ===`);
  console.log(after - before === 0
    ? "⇒ ✅ 增量 0：picker 展开【不经过】桥的 provider.getCustomAgents ⇒ 走 promptsService（H2 成立）"
    : "⇒ ⚠️ 有增量：picker 确实调用了桥 ⇒ 需回看返回值");

  conn.close();
  process.exit(0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
