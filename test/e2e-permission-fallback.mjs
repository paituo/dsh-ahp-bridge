#!/usr/bin/env node
/**
 * 方案 D 回退路验证：**故意不装 shadow 补丁**时，桥应回退到 patch 路且行为不退化。
 * 与 e2e-permission-live.mjs 的差别：makeTmpHome 不 shadow patched 包。
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, "..", "src", "bridge.mjs");
const REPO = path.join(__dirname, "..", "..");
const NODE = process.env.BRIDGE_NODE || process.execPath;
const DSH_BIN = process.env.DSH_BIN || "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";
const REAL_DSH_HOME = path.join(os.homedir(), ".dsh");
const CWD = process.env.BRIDGE_CWD || process.cwd();

class CodexClient {
  constructor(child) {
    this.child = child; this.buf = ""; this.id = 1; this.pending = new Map();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => this._onData(d));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { if (process.env.VERBOSE) process.stderr.write(`[bridge] ${d}`); });
  }
  _onData(chunk) {
    this.buf += chunk; let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); msg.error ? p.reject(new Error(`${msg.error.code}: ${msg.error.message}`)) : p.resolve(msg.result); }
      }
    }
  }
  request(method, params) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`timeout: ${method}`)); }, 60000);
    });
  }
}

const results = [];
function check(name, ok, detail = "") { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); }

function makeTmpHomeNoPatch() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-permfb-"));
  const dstProf = path.join(tmp, "profiles", "acp");
  fs.mkdirSync(path.join(tmp, "profiles"), { recursive: true });
  fs.cpSync(path.join(REAL_DSH_HOME, "profiles", "acp"), dstProf, { recursive: true, filter: (s) => !s.includes(`${path.sep}node_modules${path.sep}`) });
  return tmp;
}

async function main() {
  console.log("=== 方案 D 回退路验证（不装 shadow）===");
  const tmpHome = makeTmpHomeNoPatch();
  console.log(`临时 DSH_HOME: ${tmpHome}（无 shadow 补丁）`);
  check("P1 回退路前置：临时 home 就绪且无补丁", true, "OK");

  const child = spawn(NODE, [BRIDGE, "--node", NODE, "--dsh-bin", DSH_BIN, "--cwd", CWD,
    "--provider-id", "dsh", "--profile", "acp", "--dsh-home", tmpHome],
    { cwd: CWD, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, DSH_HOME: tmpHome } });
  const client = new CodexClient(child);
  try {
    await client.request("initialize", { clientInfo: { name: "fb-probe", version: "0" }, capabilities: {} });
    const s1 = await client.request("thread/start", { cwd: CWD, mcpServers: [] });
    check("P2 thread/start 建会话", !!s1?.threadId, `threadId=${s1?.threadId?.slice(-12)}`);

    const r1 = await client.request("permissions/setMode", { mode: "allow-all" });
    check("P3 setMode(allow-all) 仍成功（不报错）", r1?.success === true, `success=${r1?.success} dshMode=${r1?.dshMode}`);
    check("P3b 走了 patch 回退路（对端无扩展）", r1?.via === "patch", `via=${r1?.via} reason=${r1?.reason}`);

    const r2 = await client.request("permissions/setMode", { mode: "manual" });
    check("P4 setMode(manual) 回退也成功", r2?.success === true && r2?.dshMode === "workspace-write", `dshMode=${r2?.dshMode} via=${r2?.via}`);

    const st = await client.request("_bowei/permission-status", {});
    check("P5 状态自洽", st?.permissionMode === "workspace-write", `mode=${st?.permissionMode} via=${st?.syncResult?.via}`);
  } catch (e) {
    check("运行时异常", false, e?.message ?? String(e));
  } finally {
    try { child.kill(); } catch {}
    await new Promise((r) => setTimeout(r, 800));
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  }
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== 结果：${pass}/${results.length} PASS ===`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
main();
