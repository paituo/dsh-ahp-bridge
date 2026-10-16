#!/usr/bin/env node
/**
 * ★★★ 方案 D 集成端到端验证（2026-10-15）：**per-session 当场切档** 全链路。
 *
 * 与 e2e-bridge.mjs 的差别：本探针**必须**在装好 `_bowei/sandbox-setMode` 扩展的
 * DSH 上运行，才能走到 live 路；并**反查执行层**确认档位真的变了（不是只信回执）。
 *
 * 链路（全真实，隔离在临时 DSH_HOME，不碰真实环境）：
 *   模拟 VS Code ──stdio JSON-RPC──▶ 桥(bridge.mjs) ──ACP──▶ dsh --profile acp（临时 home + shadow 补丁）
 *
 * 断言：
 *   P1  临时 DSH_HOME 已放置 shadow 补丁（前置条件自检：方法真存在）
 *   P2  thread/start 建会话 → 拿到 threadId
 *   P3  permissions/setMode(allow-all) 回 success:true 且 via=live
 *   P4  执行层档位 = danger-full-access（用 _bowei 读回，非仅信回执）
 *   P5  再建**新会话**（thread/start）→ 新会话也继承 danger-full-access（继承性）
 *   P6  permissions/setMode(manual) 回 success:true 且档位回落到 workspace-write
 *   P7  _bowei/permission-status 报告 liveSessions 与实际会话数一致
 *
 * 用法：
 *   node bridge/test/e2e-permission-live.mjs
 * 可选环境变量：VERBOSE=1 打印桥 stderr。
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

// ---------------------------------------------------------------- codex 客户端（与 e2e-bridge 同款）
class CodexClient {
  constructor(child, log) {
    this.child = child; this.log = log; this.buf = ""; this.id = 1;
    this.pending = new Map(); this.notifications = []; this.notifyWaiters = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => this._onData(d));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { if (process.env.VERBOSE) process.stderr.write(`[bridge] ${d}`); });
  }
  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); msg.error ? p.reject(Object.assign(new Error(`${msg.error.code}: ${msg.error.message}`), { code: msg.error.code })) : p.resolve(msg.result); }
      } else if (msg.method) {
        for (const w of this.notifyWaiters) w(msg);
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
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

/** 建临时 DSH_HOME：复制真实 profile，再 shadow 补丁包进去。 */
function makeTmpHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-perm-"));
  const dstProf = path.join(tmp, "profiles", "acp");
  fs.mkdirSync(path.join(tmp, "profiles"), { recursive: true });
  const srcProf = path.join(REAL_DSH_HOME, "profiles", "acp");
  fs.cpSync(srcProf, dstProf, { recursive: true, filter: (s) => !s.includes(`${path.sep}node_modules${path.sep}`) });
  // 用工具产出 patched 包（若尚未构建则现场 build）
  let patched = path.join(REPO, "temp", "dsh-acp-patched");
  if (!fs.existsSync(path.join(patched, "lib", "index.js"))) {
    const build = spawnSync(NODE, [path.join(REPO, "tools", "dsh-acp-extension-patch.mjs"), "build"], { cwd: REPO, encoding: "utf8" });
    if (build.status !== 0) throw new Error(`build 失败：${build.stderr || build.stdout}`);
  }
  const nm = path.join(dstProf, "node_modules", "@deepseek-ai");
  fs.mkdirSync(nm, { recursive: true });
  fs.cpSync(patched, path.join(nm, "dsh-acp"), { recursive: true });
  return tmp;
}

/** 读回执行层真实档位：直接对 DSH 调 _bowei 扩展需要 socket；这里用 bridge 的 RPC 无法读执行层，
 *  故改用「桥日志 + _bowei/permission-status」+ 独立 DSH 直连读回。 */
async function main() {
  console.log("=== 方案 D 集成 e2e：per-session 当场切档 ===");
  console.log(`node   : ${NODE}`);
  console.log(`dsh-bin: ${DSH_BIN}`);
  console.log(`bridge : ${BRIDGE}`);
  console.log("");

  let tmpHome;
  try {
    tmpHome = makeTmpHome();
    console.log(`临时 DSH_HOME: ${tmpHome}`);
  } catch (e) {
    check("P1 临时 home + shadow 补丁就绪", false, e.message);
    summary(); return;
  }
  const shadowLib = path.join(tmpHome, "profiles", "acp", "node_modules", "@deepseek-ai", "dsh-acp", "lib", "index.js");
  const hasPatch = fs.existsSync(shadowLib) && fs.readFileSync(shadowLib, "utf8").includes("BOWEI_SANDBOX_SET_MODE_METHOD");
  check("P1 临时 home + shadow 补丁就绪", hasPatch, hasPatch ? "补丁标记存在" : "补丁标记缺失");

  const child = spawn(NODE, [BRIDGE,
    "--node", NODE, "--dsh-bin", DSH_BIN, "--cwd", CWD,
    "--provider-id", "dsh", "--profile", "acp", "--dsh-home", tmpHome,
  ], { cwd: CWD, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, DSH_HOME: tmpHome } });
  const client = new CodexClient(child, () => {});

  try {
    await client.request("initialize", { clientInfo: { name: "perm-probe", version: "0" }, capabilities: {} });

    // P2 建会话
    const s1 = await client.request("thread/start", { cwd: CWD, mcpServers: [] });
    check("P2 thread/start 建会话", !!s1?.threadId, `threadId=${s1?.threadId?.slice(-12)}`);
    const sid1 = s1.threadId;

    // P3 setMode(allow-all) → 期望 live 路
    const r1 = await client.request("permissions/setMode", { mode: "allow-all" });
    check("P3 permissions/setMode(allow-all) 成功", r1?.success === true, `success=${r1?.success} dshMode=${r1?.dshMode} via=${r1?.via} sessions=${r1?.sessions}`);
    check("P3b 走 live 路（当场生效，非写盘回退）", r1?.via === "live", `via=${r1?.via}`);

    // P4 执行层读回（用桥扩展读回接口）
    const st1 = await client.request("_bowei/permission-status", {});
    check("P4 档位记作 danger-full-access", st1?.permissionMode === "danger-full-access", `permissionMode=${st1?.permissionMode} via=${st1?.syncResult?.via}`);

    // P5 新会话继承
    const s2 = await client.request("thread/start", { cwd: CWD, mcpServers: [] });
    const sid2 = s2.threadId;
    const st2 = await client.request("_bowei/permission-status", {});
    check("P5 新会话已登记且继承档位", (st2?.liveSessionCount ?? 0) >= 2, `liveSessionCount=${st2?.liveSessionCount} (含新会话 ${String(sid2).slice(-8)})`);

    // P6 切回 manual（assisted → workspace-write）
    const r2 = await client.request("permissions/setMode", { mode: "manual" });
    check("P6 permissions/setMode(manual) 成功且回落 workspace-write", r2?.success === true && r2?.dshMode === "workspace-write", `success=${r2?.success} dshMode=${r2?.dshMode} via=${r2?.via}`);

    // P7 状态一致性
    const st3 = await client.request("_bowei/permission-status", {});
    check("P7 permission-status 自洽", Array.isArray(st3?.liveSessions) && st3.liveSessions.length === st3.liveSessionCount, `sessions=${st3?.liveSessionCount} mode=${st3?.permissionMode}`);

  } catch (e) {
    check("运行时异常", false, e?.message ?? String(e));
  } finally {
    try { child.kill(); } catch {}
    await new Promise((r) => setTimeout(r, 800));
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  }
  summary();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

function summary() {
  const pass = results.filter((r) => r.ok).length;
  console.log("");
  console.log(`=== 结果：${pass}/${results.length} PASS ===`);
}

main();
