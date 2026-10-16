#!/usr/bin/env node
/**
 * detached worktree 的「VS Code 视角」端到端 —— 真实桥进程 + 真实 JSON-RPC + 真实 git 仓库。
 *
 * 仿真 VS Code 侧 protocol client 的行为（逐字对齐 bundle 4757 行的调用形态）：
 *   1) initialize → 断言 _meta["vscode.detachedWorktrees"] === true（否则 VS Code 抛 NLS[6194]）
 *   2) 断言 create/claim/delete 三个方法**都注册了**（VS Code 的 gXn 判定链要求三者齐备）
 *   3) create(session=URI, prompt) → { handle, resource } 且 resource 可解析为真实目录
 *   4) claim(handle) → 成功
 *   5) setArchived(handle, true/false)
 *   6) reconcile(scope, activeHandles)
 *   7) delete(handle) → 目录真消失
 *   8) ★ 反向验证：--worktree false 时 initialize **不宣告** _meta ⇒ 等价于"不支持"
 */
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKTREE_META_KEY } from "../src/worktree.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, "..", "src", "bridge.mjs");
const NODE = process.execPath;
const DSH_BIN = "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}${extra ? ` — ${extra}` : ""}`); } };

const SANDBOX = path.join(os.tmpdir(), `wt-e2e-${Date.now()}`);
const STORE = path.join(SANDBOX, "store.json");
const REPO = path.join(SANDBOX, "proj");

function sh(cwd, cmd, argv) {
  const r = spawnSync(cmd, argv, { cwd, encoding: "utf8", windowsHide: true });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}
function gitInit(dir) {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  sh(dir, "git", ["config", "user.email", "t@t.t"]);
  sh(dir, "git", ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# e2e\n");
  sh(dir, "git", ["add", "-A"]);
  sh(dir, "git", ["commit", "-q", "-m", "init"]);
}

/** 起一个桥进程（stdio JSON-RPC），返回 { send, notif, close, stderr } */
function startBridge(extraArgs = []) {
  const child = spawn(NODE, [
    BRIDGE, "--node", NODE, "--dsh-bin", DSH_BIN, "--cwd", REPO,
    "--dsh-home", path.join(SANDBOX, "dshhome"),
    ...extraArgs,
  ], { cwd: REPO, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

  let buf = "", id = 0, stderrBuf = "";
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => { stderrBuf += d; });
  child.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.code}: ${msg.error.message}`)) : resolve(msg.result);
      }
    }
  });
  const send = (method, params, timeoutMs = 60000) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error("timeout: " + method)); } }, timeoutMs);
  });
  return { child, send, get stderr() { return stderrBuf; }, close: () => child.kill() };
}

(async () => {
  await fsp.rm(SANDBOX, { recursive: true, force: true });
  await fsp.mkdir(SANDBOX, { recursive: true });
  gitInit(REPO);

  const SESSION = `vscode-agent-host://e2eauth/${REPO.replace(/\\/g, "/")}`;

  // ======================= 场景 A：worktree 开启（默认）=======================
  console.log("=== A. 桥启动（worktree 默认开启）===");
  const b = startBridge(["--worktree-store", STORE]);
  // 备注：桥的 WorktreeManager 默认落 ~/.dsh/ahp-worktrees.json；为测试隔离，
  //       这里通过 --dsh-home 指到沙箱（元数据在其下）。
  let init;
  try {
    init = await b.send("initialize", { clientInfo: { name: "e2e", version: "1" }, capabilities: {} });
  } catch (e) {
    console.log("  ✗ initialize 失败:", e.message); b.close(); process.exit(1);
  }
  ok(!!init?.serverInfo, "initialize 返回 serverInfo");
  ok(init?.capabilities?.worktrees === true, "capabilities.worktrees === true");
  ok(init?._meta?.[WORKTREE_META_KEY] === true,
    `_meta["${WORKTREE_META_KEY}"] === true（VS Code 判定链的硬门槛）`,
    JSON.stringify(init?._meta));

  // ======================= 判定链：三方法齐备 =======================
  console.log("\n=== 判定链：create/claim/delete 必须都已实现 ===");
  // 用「调用不报 -32601」来证明已注册（VS Code 也是靠"方法存在"判定）
  let createRes;
  try {
    createRes = await b.send("vscode/createAgentHostDetachedWorktree", { session: SESSION, prompt: "e2e prompt" }, 90000);
  } catch (e) {
    ok(false, "create 调用成功", e.message);
  }
  ok(!!createRes?.handle && typeof createRes.handle === "string", "create → handle", JSON.stringify(createRes));
  ok(typeof createRes?.resource === "string" && createRes.resource.startsWith("file://"),
    "create → resource 是 file:// URI", createRes?.resource);
  const wtPath = decodeURIComponent(createRes.resource.replace(/^file:\/\/\/?/, "").replace(/\//g, path.sep));
  ok(fs.existsSync(wtPath), "resource 指向真实目录", wtPath);
  ok(fs.existsSync(path.join(wtPath, "README.md")), "worktree 内容真实 checkout");

  try { await b.send("vscode/claimAgentHostDetachedWorktree", { handle: createRes.handle }); ok(true, "claim 调用成功（方法已注册）"); }
  catch (e) { ok(false, "claim 调用成功", e.message); }

  // ======================= setArchived / reconcile =======================
  console.log("\n=== setArchived / reconcile ===");
  try { await b.send("vscode/setAgentHostDetachedWorktreeArchived", { handle: createRes.handle, archived: true }); ok(true, "setArchived(true) 成功"); }
  catch (e) { ok(false, "setArchived(true) 成功", e.message); }
  ok(!fs.existsSync(wtPath), "归档后目录被清理");
  try { await b.send("vscode/setAgentHostDetachedWorktreeArchived", { handle: createRes.handle, archived: false }); ok(true, "setArchived(false) 成功"); }
  catch (e) { ok(false, "setArchived(false) 成功", e.message); }
  ok(fs.existsSync(wtPath), "解档后目录被重建");

  try {
    const rc = await b.send("vscode/reconcileAgentHostDetachedWorktrees", { scope: SESSION, activeHandles: [createRes.handle] });
    ok(!!rc, "reconcile 调用成功", JSON.stringify(rc));
  } catch (e) { ok(false, "reconcile 调用成功", e.message); }

  // ======================= delete =======================
  console.log("\n=== delete（VS Code 清理会话时会调）===");
  try { await b.send("vscode/deleteAgentHostDetachedWorktree", { handle: createRes.handle }); ok(true, "delete 调用成功（方法已注册）"); }
  catch (e) { ok(false, "delete 调用成功", e.message); }
  ok(!fs.existsSync(wtPath), "delete 后目录真消失");

  // ======================= 未知方法不再误报 =======================
  console.log("\n=== 未实现方法仍正确回 -32601 ===");
  try { await b.send("vscode/someUnknownThing", {}); ok(false, "未知 vscode/* 方法应报错"); }
  catch (e) { ok(/-32601|not implemented/.test(e.message), "未知方法回 MethodNotFound", e.message); }

  b.close();
  await new Promise((r) => setTimeout(r, 500));

  // ======================= 场景 B：worktree 关闭 =======================
  console.log("\n=== B. 桥启动（--worktree false ⇒ 应视为「不支持」）===");
  const b2 = startBridge(["--worktree", "false"]);
  let init2;
  try { init2 = await b2.send("initialize", { clientInfo: { name: "e2e2", version: "1" }, capabilities: {} }); }
  catch (e) { ok(false, "initialize（关闭态）", e.message); }
  ok(init2?._meta?.[WORKTREE_META_KEY] === undefined,
    "关闭态 **不宣告** _meta ⇒ VS Code 会抛 NLS[6194]（明确「不支持」）",
    JSON.stringify(init2?._meta));
  ok(init2?.capabilities?.worktrees === false, "capabilities.worktrees === false");
  try { await b2.send("vscode/createAgentHostDetachedWorktree", { session: SESSION }); ok(false, "关闭态 create 应报错"); }
  catch (e) { ok(/-32601|not implemented/.test(e.message), "关闭态 create 回 MethodNotFound（等价于不支持）", e.message); }
  b2.close();

  // ======================= 清场 =======================
  await new Promise((r) => setTimeout(r, 400));
  await fsp.rm(SANDBOX, { recursive: true, force: true }).catch(() => {});

  console.log(`\n结果: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("ERR", e?.stack ?? e);
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
