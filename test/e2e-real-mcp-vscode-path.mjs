/**
 * ★ 真实第三方 MCP server 全链路验证 —— VS Code 视角端到端
 *
 * 与上一版（自建探针）的区别：MCP server 换成**公开的真实包**
 *   `@modelcontextprotocol/server-everything`（官方 everything reference server）
 *
 * 走完整路径（与真机一致，仅把 VS Code 的 RPC 端点换成仿真端点）：
 *   仿真 VS Code 端点 → 真实注入逻辑 reflow → 真实桥 → 真实 DSH → 真实 MCP server
 *
 * ★ 工具名以**实际 tools/list 为准**，不照抄网上文档：
 *    v2.0.0 里旧的 `add` 已改名为 `get-sum`；工具数 13（文档说 11）。
 *
 * 运行：node test/e2e-real-mcp-vscode-path.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, "..", "src", "bridge.mjs");
const NODE = process.execPath;
const DSH_BIN = "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";
const CWD = "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

async function waitFor(fn, timeoutMs = 60000, stepMs = 400) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (fn()) return true; await new Promise((r) => setTimeout(r, stepMs)); }
  return false;
}

const fired = [];
const fakeEmitter = { fire: (evt) => fired.push(evt) };
const fakeVscodeEndpoint = {
  request(method) {
    if (/requestApproval/.test(method)) return Promise.resolve({ result: { decision: "approved" } });
    if (/requestUserInput|elicitation/.test(method)) return Promise.resolve({ result: { selectedOptionId: "allow" } });
    return Promise.resolve({ result: {} });
  },
};

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
  if (x.method) reflow(x);
}

const threads = new Map();
let chatSeq = 0;
const mcpProgress = [];
const itemEvents = [];
let turnDone = false, turnError = null;

function reflow(msg) {
  const p = msg.params ?? {};
  const t = p.threadId;
  const rec = threads.get(t) ?? { chatId: `chat-${++chatSeq}`, turnId: t };
  if (!threads.has(t)) threads.set(t, rec);
  switch (msg.method) {
    case "item/agentMessage/delta": {
      const text = p.delta ?? p.text ?? "";
      if (text) fakeEmitter.fire({ type: "chat/message", chatId: rec.chatId, turnId: rec.turnId, text });
      break;
    }
    case "item/mcpToolCall/progress": mcpProgress.push(p); break;
    case "item/started":
    case "item/completed":
      if (/mcp/i.test(p.item?.type ?? "")) itemEvents.push(p);
      break;
    case "turn/completed": if (p.error) turnError = p.error; turnDone = true; break;
    case "mcpServer/startupStatus/updated": break;
    default: break;
  }
}

(async () => {
  console.log("=== 启动真实桥（真实 DSH，MCP=真实第三方包）===");
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

  // ① MCP 清单（VS Code 的 MCP 面板数据源）
  console.log("\n=== ① MCP 清单（VS Code 面板可见性）===");
  const mcpRes = await send("mcpServerStatus/list", {});
  const mcpList = mcpRes.mcpServers ?? [];
  console.log("  server:", mcpList.map((s) => `${s.name}(${s.transport})`).join(", ") || "(空)");
  ok("MCP 面板能列出 everything", mcpList.some((s) => s.name === "everything"));
  ok("清单里 args 完整（折叠标量已解析）",
    JSON.stringify(mcpList.find((s) => s.name === "everything")?.args ?? []).includes("server-everything"));

  // ② 建 thread
  console.log("\n=== ② thread/start ===");
  const st = await send("thread/start", { cwd: CWD, mcpServers: [] });
  const sid = st.threadId;
  ok("thread/start 成功（未挂死）", !!sid, sid);
  threads.set(sid, { chatId: `chat-${++chatSeq}`, turnId: sid });

  // ③ 切模型
  const opts = st.configOptions?.find((o) => o.id === "model");
  let target = null, label = null;
  for (const g of opts?.options ?? []) for (const m of (g.options ?? [])) {
    let v = m.value; if (typeof v === "string") { try { v = JSON.parse(v); } catch {} }
    if (Array.isArray(v) && v[1] === "Qwen3.8-Flash-AI") { target = m.value; label = v.join("/"); }
  }
  if (target) { await send("thread/settings/update", { threadId: sid, model: target }).catch(() => {}); ok("切模型", true, label); }

  // ④ ★ 让模型调真实 MCP 工具：echo + get-sum（v2 的工具名）
  console.log("\n=== ③ turn/start —— 模型真实调用第三方 MCP 工具 ===");
  const prompt = [
    "请真实调用 MCP 工具，并把工具返回的原文**逐字**贴出，不要改写：",
    "1) everything 的 echo，message=\"realmcp-vscode-check\"",
    "2) everything 的 get-sum，a=4096 b=777",
    "工具名形如 mcp__everything__echo / mcp__everything__get-sum。必须真实调用，禁止自己编造结果。",
  ].join("\n");

  const t0 = Date.now();
  await send("turn/start", { threadId: sid, input: [{ type: "text", text: prompt }] }, 240000);
  await waitFor(() => turnDone || /\b4873\b/.test(fired.map((e) => e.text).join("")), 180000);
  console.log("  耗时:", Date.now() - t0, "ms  (turnDone:", turnDone, turnError ? `| err=${JSON.stringify(turnError)}` : "", ")");

  console.log("\n=== MCP 工具调用通道事件 ===");
  console.log("  mcpToolCall/progress:", mcpProgress.length, "条");
  for (const p of mcpProgress.slice(0, 4)) console.log("   ·", JSON.stringify(p).slice(0, 150));
  console.log("  mcp 相关 item 事件:", itemEvents.length, "条");
  for (const p of itemEvents.slice(0, 8)) console.log("   ·", p.item?.type, "|", (p.item?.label ?? p.item?.name ?? "").slice(0, 70));

  const uiText = fired.filter((e) => e.type === "chat/message").map((e) => e.text).join("");
  console.log("\n--- 回流到 UI 的文本（前 800 字）---");
  console.log(uiText.slice(0, 800));

  console.log("\n########## 真实第三方 MCP 全链路判定 ##########");
  const hasEcho = /Echo:\s*realmcp-vscode-check/.test(uiText);
  const hasSum = /4096\s*(and|\+)\s*777\s*is\s*4873/.test(uiText) || /4873/.test(uiText);
  console.log("MCP 清单可见        :", mcpList.some((s) => s.name === "everything") ? "✅" : "❌");
  console.log("echo 返回值到 UI    :", hasEcho ? "✅" : "❌");
  console.log("get-sum 返回值到 UI :", hasSum ? "✅" : "❌");
  pass += (hasEcho ? 1 : (fail++, 0)) + (hasSum ? 1 : (fail++, 0));
  ok("UI 收到非空文本", uiText.length > 0, `${uiText.length} chars`);

  console.log(`\n结果: ${pass} passed, ${fail} failed`);
  child.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERR", e.message); child?.kill(); process.exit(1); });
