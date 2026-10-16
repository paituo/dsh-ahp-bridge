// 实测：桥的 agent/list（路线 B）—— 直连桥 stdio，走 initialize → agent/list
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(__dirname, "../src/bridge.mjs");
const NODE = process.execPath;
const DSH_BIN = "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";

const child = spawn(NODE, [
  BRIDGE, "--node", NODE, "--dsh-bin", DSH_BIN,
  "--cwd", process.cwd(), "--provider-id", "agenthost-dsh",
], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

let buf = "";
let nextId = 1;
const pending = new Map();
const logs = [];

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => { for (const l of String(d).split("\n")) if (l.trim()) logs.push(l.trim()); });

child.stdout.on("data", (chunk) => {
  buf += chunk;
  let i;
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("timeout: " + method)); } }, 30000);
  });
}

try {
  console.log("=== initialize ===");
  const init = await req("initialize", { clientInfo: { name: "audit", version: "0" }, capabilities: {} });
  console.log("capabilities:", JSON.stringify(init?.capabilities));

  console.log("\n=== agent/list ===");
  const al = await req("agent/list", {});
  console.log("counts:", JSON.stringify(al?.counts));
  console.log("agents (" + (al?.agents?.length ?? 0) + "):");
  for (const a of al?.agents ?? []) {
    console.log(`  id=${a.id}  name="${a.name}"  order=${a.order}  src=${a.source}${a.legacy ? " [LEGACY]" : ""}`);
  }
  console.log("\n=== PASS ===");
} catch (e) {
  console.log("=== FAIL:", e.message);
} finally {
  console.log("\n--- bridge logs (tail) ---");
  for (const l of logs.slice(-15)) console.log(l);
  try { child.stdin.end(); } catch {}
  setTimeout(() => process.exit(0), 1500);
}
