/**
 * ★ 多真实第三方 MCP server 全链路验证
 *
 * 在 DSH 里同时注册 3 个**真实公开 MCP server**，验证：
 *   ① 三者都能被 DSH 起来（serverName 唯一性、多 server 并存）
 *   ② 桥的清单上报 3 条
 *   ③ 模型能根据语义**自行选择正确的 server**（跨 server 路由）
 *   ④ 返回值全部回流到 UI
 *
 * 三个 server：
 *   - everything  → @modelcontextprotocol/server-everything（求和/回显）
 *   - memograph   → @modelcontextprotocol/server-memory（知识图谱）
 *   - files       → @modelcontextprotocol/server-filesystem（真实读文件）
 *
 * 运行：node test/e2e-real-mcp-multi.mjs
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
function readAll() { return fired.filter((e) => e.type === "chat/message").map((e) => e.text).join(""); }

let child, buf = "", id = 0;
const pending = new Map();
const mcpProgress = [], mcpItems = [];
let turnDone = false, turnError = null;

function send(method, params, timeoutMs = 300000) {
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
  if (!x.method) return;
  const p = x.params ?? {};
  if (x.method === "item/agentMessage/delta") { const t = p.delta ?? p.text ?? ""; if (t) fired.push({ type: "chat/message", text: t }); }
  else if (x.method === "item/mcpToolCall/progress") mcpProgress.push(p);
  else if (/^item\/(started|completed)$/.test(x.method) && /mcp/i.test(p.item?.type ?? "")) mcpItems.push(p);
  else if (x.method === "turn/completed") { if (p.error) turnError = p.error; turnDone = true; }
}

(async () => {
  console.log("=== 启动真实桥（3 个真实第三方 MCP server）===");
  child = spawn(NODE, [BRIDGE, "--provider-id", "dsh", "--dsh-bin", DSH_BIN, "--cwd", CWD], {
    cwd: CWD, stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); onLine(l); }
  });
  child.stderr.on("data", (d) => { const s = String(d); if (/error|warn/i.test(s)) process.stderr.write("[桥] " + s); });

  await send("initialize", { protocolVersion: 1, clientCapabilities: {} });
  console.log("  ✓ initialize");

  // ① 三 server 清单
  console.log("\n=== ① MCP 清单（应为 3 条）===");
  const mcpList = (await send("mcpServerStatus/list", {})).mcpServers ?? [];
  for (const s of mcpList) console.log(`   · ${s.name} | ${s.transport} | ${s.status ?? ""}`);
  ok("清单 3 条且名称正确", ["everything", "memograph", "files"].every((n) => mcpList.some((s) => s.name === n)),
    mcpList.map((s) => s.name).join(","));

  // ② thread/start
  console.log("\n=== ② thread/start ===");
  const st = await send("thread/start", { cwd: CWD, mcpServers: [] });
  const sid = st.threadId;
  ok("thread/start 成功（三 server 并存未挂死）", !!sid, sid);

  const opts = st.configOptions?.find((o) => o.id === "model");
  let target = null;
  for (const g of opts?.options ?? []) for (const m of (g.options ?? [])) {
    let v = m.value; if (typeof v === "string") { try { v = JSON.parse(v); } catch {} }
    if (Array.isArray(v) && v[1] === "Qwen3.8-Flash-AI") target = m.value;
  }
  if (target) await send("thread/settings/update", { threadId: sid, model: target }).catch(() => {});

  // ③ ★ 跨 server 路由：三个不同 server 的工具一次问清
  console.log("\n=== ③ turn/start —— 跨 3 个 server 真实调用 ===");
  const prompt = [
    "请真实调用下列 MCP 工具，并把每个工具返回的原文**逐字**贴出来（不要改写、不要自己算）：",
    "1) mcp__everything__echo  参数 message=\"MULTI_OK\"",
    "2) mcp__everything__get-sum  参数 a=1111 b=2222",
    "3) files 的读文件工具，读取 sample.txt（路径 sample.txt）",
    "4) memograph 的 create_entities，创建实体 name=\"AHPBridge\"",
    "必须逐个真实调用。若有工具不存在就说明，不要编造。",
  ].join("\n");

  const t0 = Date.now();
  await send("turn/start", { threadId: sid, input: [{ type: "text", text: prompt }] }, 300000);
  await waitFor(() => turnDone, 240000);
  console.log("  耗时:", Date.now() - t0, "ms  (turnDone:", turnDone, turnError ? `| err=${JSON.stringify(turnError)}` : "", ")");

  console.log("\n=== MCP 事件通道 ===");
  console.log("  mcpToolCall/progress:", mcpProgress.length);
  console.log("  mcp item 事件      :", mcpItems.length);
  for (const p of mcpItems.slice(0, 12)) console.log("   ·", p.item?.type, "|", (p.item?.name ?? p.item?.label ?? "").slice(0, 70));

  const uiText = readAll();
  console.log("\n--- 回流到 UI 的文本（前 1200 字）---");
  console.log(uiText.slice(0, 1200));

  console.log("\n########## 多真实 MCP server 全链路判定 ##########");
  const checks = [
    ["everything.echo 回显", /MULTI_OK/.test(uiText)],
    ["everything.get-sum 求和正确 (3333)", /3333/.test(uiText)],
    ["files 读到真实文件内容 (hello-real-mcp)", /hello-real-mcp/.test(uiText)],
    ["memograph 建实体成功（无报错且提及实体）", /AHPBridge/.test(uiText) && !/create_entities.*(not found|error)/i.test(uiText)],
  ];
  for (const [m, c] of checks) { console.log((c ? "  ✅ " : "  ❌ ") + m); if (!c) fail++; else pass++; }

  console.log(`\n结果: ${pass} passed, ${fail} failed`);
  child.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERR", e.message); child?.kill(); process.exit(1); });
