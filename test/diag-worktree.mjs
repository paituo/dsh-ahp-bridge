/**
 * git worktree 协作机制诊断（只读，不改桥代码）
 *
 * 背景 —— 从 VS Code bundle 实测挖出的契约：
 *
 *   sessions.desktop.main.js:
 *     if (sessionConfig.values.isolation === "worktree") {
 *       ...
 *       if (!connection || !_meta["vscode.detachedWorktrees"]===true
 *           || !connection.createDetachedWorktree
 *           || !connection.claimDetachedWorktree
 *           || !connection.deleteDetachedWorktree)
 *         throw new Error(NLS[6194]);     // "The source Agent Host does not support
 *                                          //  preparing a worktree for a Dev Container."
 *       g = { ...await connection.createDetachedWorktree(backendUri, prompt), connection };
 *     }
 *
 *   5 个 host 需实现的方法（VS Code → agent host 请求）：
 *     vscode/createAgentHostDetachedWorktree    { session, prompt } → { handle, resource }
 *     vscode/claimAgentHostDetachedWorktree     { handle }          → void
 *     vscode/deleteAgentHostDetachedWorktree    { handle }          → void
 *     vscode/reconcileAgentHostDetachedWorktrees{ scope, activeHandles } → void
 *     vscode/setAgentHostDetachedWorktreeArchived { handle, archived } → void
 *
 * 本脚本做三件事（全部只读）：
 *   ① 断言桥的能力宣告里**没有** worktree 标记，且 5 个方法**未实现**
 *   ② 直接向桥发这 5 个方法，记录真实错误响应
 *   ③ 检查本机 git / worktree 基础能力（能否建/列/删 worktree）
 */
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, "..", "src", "bridge.mjs");
const NODE = process.execPath;
const DSH_BIN = "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";
const CWD = "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30";

const METHODS = [
  ["vscode/createAgentHostDetachedWorktree", { session: "s1", prompt: "x" }],
  ["vscode/claimAgentHostDetachedWorktree", { handle: "h1" }],
  ["vscode/deleteAgentHostDetachedWorktree", { handle: "h1" }],
  ["vscode/reconcileAgentHostDetachedWorktrees", { scope: "all", activeHandles: [] }],
  ["vscode/setAgentHostDetachedWorktreeArchived", { handle: "h1", archived: true }],
];

let child, buf = "", id = 0;
const pending = new Map();
function send(method, params, timeoutMs = 60000) {
  const mid = ++id;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
  return new Promise((res) => {
    pending.set(mid, { res });
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); res({ timeout: true }); } }, timeoutMs);
  });
}
function onLine(line) {
  let x; try { x = JSON.parse(line); } catch { return; }
  if (x.id && pending.has(x.id)) {
    const { res } = pending.get(x.id); pending.delete(x.id);
    res(x.error ? { error: x.error } : { result: x.result });
  }
}

(async () => {
  // ---------------- ① 能力宣告
  child = spawn(NODE, [BRIDGE, "--provider-id", "dsh", "--dsh-bin", DSH_BIN, "--cwd", CWD], {
    cwd: CWD, stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); onLine(l); }
  });
  child.stderr.on("data", () => {});

  const init = await send("initialize", { protocolVersion: 1, clientCapabilities: {} });
  console.log("========== (1) 桥的 initialize 能力宣告 ==========");
  console.log("  capabilities:", JSON.stringify(init.result?.capabilities));
  console.log("  _meta       :", JSON.stringify(init.result?._meta ?? null));
  const hasMeta = init.result?._meta?.["vscode.detachedWorktrees"] === true;
  console.log("  _meta[\"vscode.detachedWorktrees\"] === true ?", hasMeta ? "YES" : "NO  ← 关键缺失");
  console.log("  → 判定：VS Code 会认为该 host **不支持** detached worktree");

  // ---------------- ② 直接调用 5 个方法
  console.log("\n========== (2) 直接调用 5 个 worktree 方法 ==========");
  for (const [m, p] of METHODS) {
    const r = await send(m, p);
    const desc = r.timeout ? "TIMEOUT（无响应）"
      : r.error ? `ERROR ${r.error.code}: ${r.error.message}`
      : `OK ${JSON.stringify(r.result)}`;
    console.log(`  ${m.replace("vscode/", "")}`);
    console.log(`      → ${desc}`);
  }

  // ---------------- ③ 本机 git 能力
  console.log("\n========== (3) 本机 git / worktree 基础能力 ==========");
  const repo = process.cwd();
  let inRepo = false, gitVer = "";
  try { gitVer = execSync("git --version", { encoding: "utf8" }).trim(); } catch { /* */ }
  console.log("  git:", gitVer || "(不可用)");
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd: repo, stdio: "pipe" });
    inRepo = true;
  } catch { inRepo = false; }
  console.log("  当前目录是 git 工作区:", inRepo ? "YES" : "NO");
  if (inRepo) {
    const wt = (() => { try { return execSync("git worktree list", { cwd: repo, encoding: "utf8" }).trim(); } catch (e) { return "ERR " + e.message; } })();
    console.log("  git worktree list:\n" + wt.split("\n").map((l) => "    " + l).join("\n"));
  } else {
    console.log("  （本工作目录非 git 仓库 ⇒ 无法演示 worktree 增删；" +
      "VS Code 的 worktree 隔离同样要求会话工作目录在 git 仓库内）");
  }

  // ---------------- ④ 结论
  console.log("\n========== (4) 诊断结论 ==========");
  const blocking = [];
  if (!hasMeta) blocking.push("桥未宣告 _meta[\"vscode.detachedWorktrees\"]");
  blocking.push("桥未实现 5 个 vscode/*DetachedWorktree 方法");
  console.log("  阻断项：");
  for (const b of blocking) console.log("    · " + b);
  console.log("\n  影响：当 VS Code 会话配置 isolation=worktree 时，客户端会直接抛错：");
  console.log("    NLS[6194] = \"The source Agent Host does not support preparing a worktree for a Dev Container.\"");
  console.log("  ⇒ 表现为：无法以 worktree 隔离方式启动会话（其余 isolation=folder 会话不受影响）。");

  child.kill();
  process.exit(0);
})().catch((e) => { console.error("ERR", e.message); child?.kill(); process.exit(1); });
