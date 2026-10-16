// 用旧版 bridge.mjs（备份）跑冷启动 model/list，证明修复前确实返回 0
import { spawn } from "node:child_process";
const BRIDGE = process.argv[2];
const NODE = process.execPath;
const DSH_BIN = "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";
const CWD = "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30";
const child = spawn(NODE, [BRIDGE, "--node", NODE, "--dsh-bin", DSH_BIN, "--cwd", CWD, "--provider-id", "dsh", "--profile", "acp"], { cwd: CWD, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
if (process.env.VERBOSE) child.stderr.on("data", (d) => process.stderr.write("[old] " + d));
let buf = "", id = 1; const pending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!l) continue;
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    }
  }
});
const req = (method, params) => new Promise((res, rej) => {
  const i = id++; pending.set(i, { resolve: res, reject: rej });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
  setTimeout(() => { if (pending.delete(i)) rej(new Error("timeout " + method)); }, 30000);
});
const t = Date.now();
await req("initialize", { clientInfo: { name: "x", version: "0" }, capabilities: {} });
const r = await req("model/list", {});
console.log(`旧版冷启动 model/list → models=${(r.models || []).length}  (${Date.now() - t}ms)`);
child.kill(); process.exit(0);
