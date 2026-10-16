#!/usr/bin/env node
/**
 * 真实第三方 MCP server 自检 —— 直接喂 JSON-RPC，确认「官方 everything server」协议面。
 *
 * 目的：在把它接进 DSH 之前，先证明**这个 server 本身就是合规的真实 MCP server**
 *       （否则后面链路失败无法区分是 server 问题还是桥/DSH 问题）。
 *
 * 运行：node test/probe-real-mcp-everything.mjs
 */
import { spawn } from "node:child_process";

const NPX = "C:/Users/liuyue/.workbuddy/binaries/node/versions/22.22.2-2/npx.cmd";
const PKG = "@modelcontextprotocol/server-everything";

let child, buf = "", id = 0;
const pending = new Map();

function send(method, params, timeoutMs = 90000) {
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
  }
}

(async () => {
  console.log("=== 启动真实第三方 MCP server ===");
  console.log("  包名:", PKG);
  child = spawn(NPX, ["--yes", PKG, "stdio"], { stdio: ["pipe", "pipe", "pipe"], shell: true });
  child.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); onLine(l); }
  });
  child.stderr.on("data", (d) => process.stderr.write("[mcp] " + d));

  // ① initialize
  const init = await send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "ahp-probe", version: "0.1.0" },
  });
  console.log("\n=== ① initialize ===");
  console.log("  protocolVersion:", init.protocolVersion);
  console.log("  serverInfo     :", JSON.stringify(init.serverInfo));
  console.log("  capabilities   :", Object.keys(init.capabilities ?? {}).join(", "));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // ② tools/list —— 应与公开文档一致（echo / add / longRunningOperation / ...）
  const tl = await send("tools/list", {});
  const tools = tl.tools ?? [];
  console.log("\n=== ② tools/list ===");
  console.log("  工具数:", tools.length);
  for (const t of tools) console.log("   ·", t.name, "|", (t.description ?? "").slice(0, 60));
  const names = tools.map((t) => t.name);

  // ③ 真实调用 get-sum（结果必须真实计算）与 echo
  //    ★ 注意：v2.0.0 已把旧文档里的 `add` 改名为 `get-sum`（网上文档不可照抄）
  console.log("\n=== ③ tools/call（真实执行）===");
  const sumTool = tools.find((t) => t.name === "get-sum");
  const sumArgs = {};
  for (const k of Object.keys(sumTool?.inputSchema?.properties ?? {})) sumArgs[k] = 1234 + (k === "b" ? 4444 : 0);
  console.log("  get-sum arguments:", JSON.stringify(sumArgs));
  const add = await send("tools/call", { name: "get-sum", arguments: sumArgs });
  const addText = (add.content ?? []).map((c) => c.text ?? "").join("");
  console.log("  get-sum       →", JSON.stringify(addText.slice(0, 200)));
  const echo = await send("tools/call", { name: "echo", arguments: { message: "REAL_MCP_ECHO" } });
  const echoText = (echo.content ?? []).map((c) => c.text ?? "").join("");
  console.log("  echo          →", JSON.stringify(echoText.slice(0, 200)));

  // ④ resources/list + prompts/list —— 协议面完整性
  console.log("\n=== ④ resources / prompts ===");
  const rl = await send("resources/list", {});
  console.log("  resources:", (rl.resources ?? []).length, "条");
  for (const r of (rl.resources ?? []).slice(0, 8)) console.log("   ·", r.uri, "|", (r.title ?? r.name ?? "").slice(0, 40));
  const pl = await send("prompts/list", {});
  console.log("  prompts  :", (pl.prompts ?? []).map((p) => p.name).join(", ") || "(空)");

  console.log("\n########## 真实 MCP server 自检判定 ##########");
  const checks = [
    ["serverInfo 为官方 everything", /everything/i.test(init.serverInfo?.name ?? "")],
    ["具备 tools 能力", !!init.capabilities?.tools],
    ["具备 resources 能力", !!init.capabilities?.resources],
    ["具备 prompts 能力", !!init.capabilities?.prompts],
    ["工具含 echo", names.includes("echo")],
    ["工具含 get-sum（v2 的 add）", names.includes("get-sum")],
    ["get-sum 真实计算正确 (5678)", /5678/.test(addText)],
    ["echo 真实回显", /REAL_MCP_ECHO/.test(echoText)],
  ];
  let fail = 0;
  for (const [m, c] of checks) { console.log((c ? "  ✅ " : "  ❌ ") + m); if (!c) fail++; }
  console.log(fail ? `\n自检失败 ${fail} 项` : "\n自检全部通过");
  child.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERR", e.message); child?.kill(); process.exit(1); });
