#!/usr/bin/env node
/**
 * modelSelectionFailed 修复的真机验证脚本（2026-10-12）
 *
 * 用法（重启 VS Code + 在 Agents 窗口新建 dsh 会话发一条消息之后）：
 *   node bridge/tools/verify-modelselection-fix.mjs
 *
 * 判据：
 *   PASS —— 日志出现 `changeModel reroute` / `changeModel reroute ok`
 *           且**不再**出现 `modelSelection failed` / `无法获取`
 *   FAIL —— 仍出现 `modelSelection failed`（修复未生效或注入旧版）
 *
 * 只读：仅扫描日志文件，不改任何状态。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INJECT_LOG = path.join(__dirname, "..", "temp", "inject-bridge.log");

if (!fs.existsSync(INJECT_LOG)) {
  console.log("✗ 找不到注入日志:", INJECT_LOG);
  console.log("  请确认 VS Code 已重启且 DSH provider 已 boot（看日志目录是否生成）。");
  process.exit(2);
}

const s = fs.readFileSync(INJECT_LOG, "utf8");
const lines = s.split(/\r?\n/);

const count = (re) => lines.filter((l) => re.test(l)).length;

const nBoot = count(/snippet boot/);
const nInjected = count(/provider injected:/);
const nReroute = count(/changeModel reroute:/);
const nRerouteOk = count(/changeModel reroute ok:/);
const nRerouteFail = count(/changeModel reroute failed/);
const nModelSelFail = count(/modelSelection failed/);
const nNotAvailable = count(/无法获取/);

console.log("=== modelSelectionFailed 修复验证 ===");
console.log("日志:", INJECT_LOG);
console.log();
console.log(`  注入进程 boot 次数        : ${nBoot}`);
console.log(`  provider injected 次数    : ${nInjected}`);
console.log(`  changeModel reroute 次数  : ${nReroute}`);
console.log(`  changeModel reroute ok    : ${nRerouteOk}`);
console.log(`  changeModel reroute failed: ${nRerouteFail}`);
console.log(`  ★ modelSelection failed   : ${nModelSelFail}`);
console.log(`  ★ "'...' 无法获取"        : ${nNotAvailable}`);
console.log();

let verdict;
if (nInjected === 0) {
  verdict = "PENDING —— 尚未看到新的注入 boot（VS Code 可能还没重启，或未打开 Agents 窗口）";
} else if (nModelSelFail > 0 || nNotAvailable > 0) {
  verdict = "FAIL —— 仍出现 modelSelection failed（注入可能未生效/是旧版片段）";
} else if (nReroute > 0) {
  verdict = "PASS —— changeModel 已改道走桥，且无 modelSelection failed";
} else {
  verdict = "INCONCLUSIVE —— 无报错但也未见 changeModel reroute（可能未触发发送，或本会话没发过消息）";
}
console.log("结论:", verdict);

if (nReroute > 0) {
  console.log("\n最近 8 条 changeModel 相关日志：");
  for (const l of lines.filter((l) => /changeModel/.test(l)).slice(-8)) console.log("  " + l);
}
if (nModelSelFail > 0) {
  console.log("\n★ 仍存在的 modelSelection failed 日志：");
  for (const l of lines.filter((l) => /modelSelection failed/.test(l)).slice(-5)) console.log("  " + l);
}
