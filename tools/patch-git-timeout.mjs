#!/usr/bin/env node
/**
 * P2-1 修复工具：提高 agent host `_runGit` 的**默认超时**（5s → 30s）。
 *
 * 背景（源码实证）：
 *   agentHostMain.js 中 `_runGit(i, e, t)` 的默认超时是：
 *       let a = t?.timeout ?? 5e3
 *   ⇒ 任何**未显式传 timeout** 的 git 调用都只有 5 秒。
 *   而 checkpoint / diff 的 `_stageChangedPaths()` 调用形如：
 *       this._runGit(i, ["add","-A",`--pathspec-from-file=...`,"--pathspec-file-nul"],
 *                    { env: { ..., GIT_LITERAL_PATHSPECS:"1" } })     // ★ 无 timeout
 *   ⇒ 在大仓（如 bowei-agent-work）上 `git add -A` 必超时 5000ms。
 *   现象：`[agentHostGitService] > git add -A ... failed: git add timed out after 5000ms`
 *   影响：还原检查点 / 查看 diff 功能降级（不影响对话）。
 *
 * 修法：单点把 `t?.timeout??5e3` → `t?.timeout??3e4`（30s，与 bundle 内其它 git 操作
 *       yMe=3e4 的既有约定一致）。该模式在 bundle 内**全局唯一**，替换安全。
 *
 * 用法：
 *   node patch-git-timeout.mjs status   # 查看当前状态
 *   node patch-git-timeout.mjs apply    # 打补丁（自动备份 → 写入 → node --check）
 *   node patch-git-timeout.mjs revert   # 回滚（精确还原 5e3）
 *
 * ★ 与 apply-p3.mjs **互不干扰**：本工具只改 `_runGit` 的超时常量，
 *   不触碰 BOWEI-DSH-P3 注入片段；两者可任意顺序 apply/revert。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { locateVSCode } from "./vscode-locate.mjs";

const VSCODE_OUT = process.env.BOWEI_VSCODE_OUT || locateVSCode().out;
const TARGET = path.join(VSCODE_OUT, "platform/agentHost/node/agentHostMain.js");

const FROM = "t?.timeout??5e3";
const TO = "t?.timeout??3e4";

const read = (p) => fs.readFileSync(p, "utf8");

function check(file = TARGET) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: String(e.stderr || e.stdout || e).slice(0, 2000) };
  }
}

function backup(src, suffix) {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const b = `${TARGET}.bak_gittimeout_${suffix}_${ts}`;
  fs.writeFileSync(b, src);
  return b;
}

function status() {
  const s = read(TARGET);
  const nFrom = s.split(FROM).length - 1;
  const nTo = s.split(TO).length - 1;
  console.log(`target : ${TARGET}`);
  console.log(`size   : ${s.length}`);
  console.log(`原模式 "${FROM}"      : ${nFrom} 处`);
  console.log(`已补模式 "${TO}" : ${nTo} 处`);
  if (nTo === 1 && nFrom === 0) console.log("状态   : 已修复 ✅（默认超时 = 30s）");
  else if (nFrom === 1 && nTo === 0) console.log("状态   : 未修复（默认超时 = 5s）");
  else console.log("状态   : ★ 异常（模式计数 ≠ 1，可能被其它补丁改动）");
  return nFrom === 1;
}

function apply() {
  const s = read(TARGET);
  if (s.includes(TO) && !s.includes(FROM)) { console.log("已修复，无需重复 apply。"); return; }
  const n = s.split(FROM).length - 1;
  if (n !== 1) { console.log(`★ 原模式出现 ${n} 处（应为 1），拒绝打补丁。`); return; }
  const b = backup(s, "before");
  console.log(`已备份 → ${b}`);
  const out = s.replace(FROM, TO);
  fs.writeFileSync(TARGET, out);
  console.log("已写入（5e3 → 3e4）。");
  const c = check();
  if (!c.ok) {
    console.log("★ node --check FAIL → 从备份恢复");
    console.log(c.msg);
    fs.copyFileSync(b, TARGET);
    console.log("已恢复。");
  } else {
    console.log("node --check: OK ✅");
  }
}

function revert() {
  const s = read(TARGET);
  if (!s.includes(TO)) { console.log("当前未打补丁（无 3e4 模式）。"); return; }
  const b = backup(s, "beforeRevert");
  console.log(`已备份 → ${b}`);
  const out = s.replace(TO, FROM);
  fs.writeFileSync(TARGET, out);
  console.log("已回滚（3e4 → 5e3）。");
  const c = check();
  console.log("node --check:", c.ok ? "OK ✅" : "FAIL\n" + c.msg);
}

const cmd = process.argv[2] || "status";
if (cmd === "status") status();
else if (cmd === "apply") apply();
else if (cmd === "revert") revert();
else console.log("用法: node patch-git-timeout.mjs [status|apply|revert]");
