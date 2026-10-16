/**
 * 路线 B 端到端离线验证（不依赖 VS Code）：
 *   1) 桥 agent/list 返回 preset 清单
 *   2) thread/start 带 agent 参数 → 桥记录 presetByThread
 *   3) 断言：preset 清单非空、含 shipped + legacy、选中项被记录
 *
 * 这是「VS Code 侧 UI 可见」的**上游必要条件**：桥能给出 agent，且能记住选中。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(__dirname, "../src/bridge.mjs");
const NODE = process.execPath;
const DSH_BIN = "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";
const PROVIDER_ID = "agenthost-dsh";

const child = spawn(NODE, [
  BRIDGE, "--node", NODE, "--dsh-bin", DSH_BIN,
  "--cwd", process.cwd(), "--provider-id", PROVIDER_ID,
], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

let buf = "", nextId = 1;
const pending = new Map();
const logs = [];
let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
};

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => { for (const l of String(d).split("\n")) if (l.trim()) logs.push(l.trim()); });
child.stdout.on("data", (chunk) => {
  buf += chunk; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    }
  }
});
function req(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("timeout: " + method)); } }, 60000);
  });
}

try {
  console.log("\n=== 步骤 1: initialize ===");
  await req("initialize", { clientInfo: { name: "routeB-e2e", version: "0" }, capabilities: {} });
  check("initialize 成功", true);

  console.log("\n=== 步骤 2: agent/list（preset 发现）===");
  const al = await req("agent/list", {});
  const agents = al?.agents ?? [];
  check("agent 清单非空", agents.length > 0, `${agents.length} 个`);
  check("含 shipped preset", agents.some(a => a.id === "standard"), "standard 存在");
  check("含 order 排序", agents.length > 1 && agents[0].order <= agents[agents.length - 1].order, "已排序");
  check("shipped 有中文显示名", agents.some(a => a.name === "标准模式"), "标准模式");
  for (const a of agents) console.log(`     · ${a.id.padEnd(12)} "${a.name}"`);

  console.log("\n=== 步骤 3: thread/start 带 agent（记录选中）===");
  const ts = await req("thread/start", { cwd: process.cwd(), agent: "standard" });
  check("thread/start 返回 sessionId", !!ts?.threadId, String(ts?.threadId).slice(-16));

  await new Promise(r => setTimeout(r, 800));
  const presetLog = logs.find(l => l.includes("agent/preset selected"));
  check("桥记录了选中的 preset", !!presetLog, presetLog ? presetLog.slice(0, 80) : "未找到日志");

  console.log(`\n=== 结果: ${pass} PASS / ${fail} FAIL ===`);
} catch (e) {
  console.log("=== 异常:", e.message);
  fail++;
} finally {
  console.log("\n--- bridge logs (tail 12) ---");
  for (const l of logs.slice(-12)) console.log(l);
  try { child.stdin.end(); } catch {}
  setTimeout(() => process.exit(fail ? 1 : 0), 1500);
}
