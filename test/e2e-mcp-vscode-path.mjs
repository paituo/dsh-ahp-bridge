/**
 * MCP 全链路真机验证 —— VS Code 视角端到端
 *
 * 走完整路径（与真机一致，仅把 VS Code 的 RPC 端点换成仿真端点）：
 *   仿真 VS Code 端点 → 真实注入片段逻辑 → 真实桥 → 真实 DSH → 真实 MCP server
 *
 * 断言：模型调用 MCP 工具（mcp__ahpprobe__echo / add）的**真实返回值**
 *      能一路回流到 UI（假 emitter fire 出来的 chat/message 文本里）。
 *
 * 这比 ACP 层测试更强：证明「MCP 工具在 VS Code 里可用」而不只是「DSH 能用」。
 *
 * 运行：node test/e2e-mcp-vscode-path.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { readMessageText } from "../src/inject-snippet.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, "..", "src", "bridge.mjs");
const NODE = process.execPath;
const DSH_BIN = "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";
const CWD = "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

/** 轮询等待条件成立（用于等异步推送） */
async function waitFor(fn, timeoutMs = 60000, stepMs = 500) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

const fired = [];
const fakeEmitter = { fire: (evt) => fired.push(evt) };

// 仿真 VS Code RPC 端点（审批自动放行）
const fakeVscodeEndpoint = {
  request(method) {
    if (/requestApproval/.test(method)) return Promise.resolve({ result: { decision: "approved" } });
    if (/requestUserInput|elicitation/.test(method)) return Promise.resolve({ result: { selectedOptionId: "allow" } });
    return Promise.resolve({ result: {} });
  },
};

// 极简 JSON-RPC 桥客户端
let child, buf = "", id = 0;
const pending = new Map();
function send(method, params, timeoutMs = 180000) {
  const mid = ++id;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
  return new Promise((res, rej) => {
    pending.set(mid, { res, rej });
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error("timeout " + method)); } }, timeoutMs);
  });
}
function onLine(line) {
  let x; try { x = JSON.parse(line); } catch { return; }
  if (x.id && pending.has(x.id)) {
    const { res, rej } = pending.get(x.id); pending.delete(x.id);
    x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result);
    return;
  }
  // 通知 → 模拟注入层 reflow（照搬 inject-snippet 的核心分支）
  if (x.method) reflow(x);
}

const threads = new Map();   // sessionId -> { chatId, turnId }
let chatSeq = 0;

/** 模拟注入片段的 reflow：把桥通知转成 VS Code chat 事件 */
function reflow(msg) {
  const p = msg.params ?? {};
  const t = p.threadId;
  const rec = threads.get(t) ?? { chatId: `chat-${++chatSeq}`, turnId: t };
  if (!threads.has(t)) threads.set(t, rec);
  switch (msg.method) {
    // ★ 桥的消息增量通道是 `item/agentMessage/delta`（与注入层 reflow 对齐）
    case "item/agentMessage/delta": {
      const text = p.delta ?? p.text ?? "";
      if (text) fakeEmitter.fire({ type: "chat/message", chatId: rec.chatId, turnId: rec.turnId, text });
      break;
    }
    // ★ MCP 工具调用进度（专门通道）
    case "item/mcpToolCall/progress": {
      mcpProgress.push(p);
      break;
    }
    case "item/started":
    case "item/completed": {
      if (p.item?.type === "mcpToolCall" || /mcp/i.test(p.item?.type ?? "")) itemEvents.push(p);
      break;
    }
    case "turn/completed": {
      if (p.error) turnError = p.error;
      turnDone = true;
      break;
    }
    case "mcpServer/startupStatus/updated": break;   // 静默（与真机一致）
    default: break;
  }
}

const mcpProgress = [];
const itemEvents = [];
let turnDone = false;
let turnError = null;

(async () => {
  console.log("=== 启动真实桥（含真实 DSH）===");
  child = spawn(NODE, [BRIDGE, "--provider-id", "dsh", "--dsh-bin", DSH_BIN, "--cwd", CWD], {
    cwd: CWD, stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); onLine(l); }
  });
  child.stderr.on("data", (d) => process.stderr.write("[桥] " + d));

  await send("initialize", { protocolVersion: 1, clientCapabilities: {} });
  console.log("  ✓ initialize");

  // ① MCP 清单可见（VS Code 的 MCP 面板数据源）
  console.log("\n=== ① MCP 清单（VS Code 面板可见性）===");
  const mcpRes = await send("mcpServerStatus/list", {});
  const mcpList = mcpRes.mcpServers ?? [];
  console.log("  server:", mcpList.map((s) => `${s.name}(${s.transport})`).join(", ") || "(空)");
  ok("MCP 面板能列出 ahpprobe", mcpList.some((s) => s.name === "ahpprobe"));

  // ② 建 thread（回落 DSH 声明的 MCP）
  console.log("\n=== ② thread/start ===");
  const st = await send("thread/start", { cwd: CWD, mcpServers: [] });
  const sid = st.threadId;
  ok("thread/start 成功", !!sid, sid);
  threads.set(sid, { chatId: `chat-${++chatSeq}`, turnId: sid });

  // ③ 切模型到可用模型
  const opts = st.configOptions?.find((o) => o.id === "model");
  let target = null, label = null;
  for (const g of opts?.options ?? []) for (const m of (g.options ?? [])) {
    let v = m.value; if (typeof v === "string") { try { v = JSON.parse(v); } catch {} }
    if (Array.isArray(v) && v[1] === "Qwen3.8-Flash-AI") { target = m.value; label = v.join("/"); }
  }
  if (target) { await send("thread/settings/update", { threadId: sid, model: target }).catch(() => {}); ok("切模型", true, label); }

  // ④ ★ 关键：通过桥发 prompt，让模型调 MCP 工具
  console.log("\n=== ③ turn/start —— 让模型真实调用 MCP 工具 ===");
  const prompt = [
    "请调用 MCP 工具，把原始返回值原样贴出：",
    "1) ahpprobe 的 echo，text=\"vscode-mcp-check\"",
    "2) ahpprobe 的 add，a=17 b=25",
    "工具名 mcp__ahpprobe__echo / mcp__ahpprobe__add。必须真实调用。",
  ].join("\n");

  const t0 = Date.now();
  await send("turn/start", { threadId: sid, input: [{ type: "text", text: prompt }] }, 240000);
  // ★ turn/start 是**异步启动**（回执很快，内容经通知推送）⇒ 等 turn/completed 或出现结果。
  const done = await waitFor(() => turnDone || /MCP_ADD_RESULT/.test(fired.map((e) => e.text).join("")), 180000);
  const elapsed = Date.now() - t0;
  console.log("  耗时:", elapsed, "ms  (turnDone:", turnDone, turnError ? `| err=${JSON.stringify(turnError)}` : "", ")");

  console.log("\n=== MCP 工具调用通道事件 ===");
  console.log("  mcpToolCall/progress:", mcpProgress.length, "条");
  for (const p of mcpProgress.slice(0, 4)) console.log("   ·", JSON.stringify(p).slice(0, 160));
  console.log("  mcp 相关 item 事件:", itemEvents.length, "条");
  for (const p of itemEvents.slice(0, 6)) console.log("   ·", p.item?.type, "|", (p.item?.label ?? p.item?.name ?? "").slice(0, 60));

  // ⑤ 断言：回流到 UI 的文本里含 MCP 工具真实返回值
  const uiText = fired
    .filter((e) => e.type === "chat/message")
    .map((e) => e.text)
    .join("");
  console.log("\n--- 回流到 UI 的文本（前 700 字）---");
  console.log(uiText.slice(0, 700));

  console.log("\n########## MCP 全链路（VS Code 视角）判定 ##########");
  const hasEcho = /MCP_ECHO_OK/.test(uiText);
  const hasAdd = /MCP_ADD_RESULT:?\s*42/.test(uiText);
  console.log("MCP 清单可见      :", mcpList.some((s) => s.name === "ahpprobe") ? "✅" : "❌");
  console.log("echo 返回值到 UI  :", hasEcho ? "✅" : "❌");
  console.log("add  返回值到 UI  :", hasAdd ? "✅" : "❌");
  pass += (hasEcho ? 1 : (fail++, 0)) + (hasAdd ? 1 : (fail++, 0));
  ok("UI 收到非空文本", uiText.length > 0, `${uiText.length} chars`);

  console.log(`\n结果: ${pass} passed, ${fail} failed`);
  child.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERR", e.message); child?.kill(); process.exit(1); });
