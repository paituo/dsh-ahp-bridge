#!/usr/bin/env node
/**
 * 临时诊断：在 `Session was never created on the backend` 抛出前打印调用栈，
 * 以确定真正的调用路径（静态分析已绕圈，需 ground truth）。
 *
 * 用法：
 *   node diag-nevercreated-stack.mjs apply    # 打诊断补丁
 *   node diag-nevercreated-stack.mjs revert   # 回滚
 *   node diag-nevercreated-stack.mjs status
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { locateVSCode } from "./vscode-locate.mjs";

const VSCODE_OUT = process.env.BOWEI_VSCODE_OUT || locateVSCode().out;
const TARGET = path.join(VSCODE_OUT, "platform/agentHost/node/agentHostMain.js");

const NEEDLE = "ke&&this._provisionalSessionKeys.has(n)?";
const PATCHED = "ke&&this._provisionalSessionKeys.has(n)?(console.error('[DIAG-nevercreated] stack for '+n+'\\n'+new Error().stack),0)||";

const read = (p) => fs.readFileSync(p, "utf8");
function check() {
  try { execFileSync(process.execPath, ["--check", TARGET], { stdio: "pipe" }); return true; }
  catch (e) { console.log("node --check FAIL\n" + String(e.stderr || e).slice(0, 1200)); return false; }
}
function backup(s, suffix) {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const b = `${TARGET}.bak_diag_${suffix}_${ts}`;
  fs.writeFileSync(b, s); return b;
}

const cmd = process.argv[2] || "status";
if (cmd === "status") {
  const s = read(TARGET);
  console.log("原模式:", s.split(NEEDLE).length - 1, "处");
  console.log("已打补丁:", s.split(PATCHED).length - 1, "处");
} else if (cmd === "apply") {
  let s = read(TARGET);
  if (s.includes(PATCHED)) { console.log("已打补丁"); process.exit(0); }
  if (s.split(NEEDLE).length - 1 !== 1) { console.log("★ 原模式计数≠1，拒绝"); process.exit(1); }
  console.log("已备份 →", backup(s, "before"));
  s = s.replace(NEEDLE, PATCHED);
  fs.writeFileSync(TARGET, s);
  console.log("已打诊断补丁。check:", check() ? "OK" : "FAIL");
} else if (cmd === "revert") {
  let s = read(TARGET);
  if (!s.includes(PATCHED)) { console.log("未打补丁"); process.exit(0); }
  console.log("已备份 →", backup(s, "beforeRevert"));
  s = s.replace(PATCHED, NEEDLE);
  fs.writeFileSync(TARGET, s);
  console.log("已回滚。check:", check() ? "OK" : "FAIL");
} else console.log("用法: status|apply|revert");
