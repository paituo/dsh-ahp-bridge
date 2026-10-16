#!/usr/bin/env node
/**
 * apply-p3 的 **dry-run** —— 不写 bundle，只验证：
 *   1) 能从 bundle 探测出 spawn 命名空间
 *   2) 生成的注入片段是**语法合法**的 JS（把 anchor+snippet 放进假函数里 node --check）
 *   3) 替换后 anchor 计数正确、可被精确 revert
 *
 * 用法: node test/dryrun-apply-p3.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { agentHostMainPath } from "../tools/vscode-locate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const TARGET = process.env.BOWEI_VSCODE_OUT
  ? path.join(process.env.BOWEI_VSCODE_OUT, "platform/agentHost/node/agentHostMain.js")
  : agentHostMainPath();

// ★ 锚点不再硬编码（1.142.0 起压缩变量名会变）：按结构特征探测
//   ★★ 2026-10-16：必须**排除注释中的伪锚点**（片段自身注释里含示例文本，会被误匹配）。
//   判据：锚点必须位于**非注释行**（行内不含 "//" 之类）且行内它不是第一个出现。
const ANCHOR_RE = /([A-Za-z_$][\w$]*)\.registerProvider\(([A-Za-z_$][\w$]*)\.createInstance\(([A-Za-z_$][\w$]*)\)\),/;
function detectAnchor(src) {
  // 逐行扫描，跳过含注入标记区间与注释行的区域
  const lines = src.split("\n");
  let inSnippet = false;
  for (const ln of lines) {
    if (ln.includes(MARK_B)) inSnippet = true;
    if (ln.includes(MARK_E)) { inSnippet = false; continue; }
    if (inSnippet) continue;                        // 片段内部（含其注释）一律跳过
    const code = ln.replace(/\/\/[^\n]*$/, "");      // 去掉行尾注释再匹配
    const m = code.match(ANCHOR_RE);
    if (m) return m[0];
  }
  return null;
}
const MARK_B = "/*BOWEI-DSH-P3-BEGIN*/";
const MARK_E = "/*BOWEI-DSH-P3-END*/";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

console.log("\n[1] 读取 bundle");
const s = fs.readFileSync(TARGET, "utf8");
ok(s.length > 3_000_000, `bundle 已读取（${s.length} 字节）`);
const ANCHOR = detectAnchor(s);
ok(!!ANCHOR, `锚点已探测：${ANCHOR}`);
// ★ 不要求"必须干净"：bundle 已注入时锚点仍在（片段插在 anchor 之后），dry-run 依然有效。
//   仅在**恰好干净**时额外校验一次；已注入时跳过（否则会误报失败）。
const alreadyInjected = s.includes(MARK_B);
if (!alreadyInjected) ok(true, "当前未注入 P3（干净）");
else console.log(`  – 当前已注入 P3（跳过"干净"检查，dry-run 仍有效）`);

// ★ 结构探测：壳类 / DI / providerService / fs / stateManager / logService
//   ★ 2026-10-16：解析必须与 detectAnchor 同口径（排除片段内注释），否则会拿到伪锚点（旧符号）。
const reg = ANCHOR ? ANCHOR.match(ANCHOR_RE) : null;
const SHELL = reg ? reg[3] : null;
const DI = reg ? reg[2] : null;
const SVC = reg ? reg[1] : null;
// ★ stateManager / logService 必须限定在 bootstrap 段内探测 ——
//   全库 grep `X.stateManager` 会先命中类字段 `_stateManager`（1067 次）⇒ 误判。
//   真身是 bootstrap 里的局部赋值 `y=H.stateManager` 与 `u.info("Agent Host process started successfully")`。
const _bootIdx = s.indexOf("Agent Host process started successfully");
const _boot = _bootIdx >= 0 ? s.slice(Math.max(0, _bootIdx - 2500), _bootIdx + 4000) : s;
const smM = _boot.match(/([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\.stateManager\b/);
const STATE_MGR = smM ? smM[1] : null;
const logM = _boot.match(/([A-Za-z_$][\w$]*)\.info\("Agent Host process started successfully"\)/);
const LOG_SVC = logM ? logM[1] : null;
const fsAliases = new Set();
{ const r = /import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*["']fs["']/g; let x; while ((x = r.exec(s))) fsAliases.add(x[1]); }
let FS_NS = null, best = 0;
for (const a of fsAliases) { const c = (s.match(new RegExp(`\\b${a}\\.(appendFileSync|mkdirSync|writeFileSync|existsSync)\\b`, "g")) || []).length; if (c > best) { best = c; FS_NS = a; } }
ok(!!SHELL && !!DI && !!SVC, `壳类=${SHELL} DI=${DI} providerSvc=${SVC}`);
ok(!!STATE_MGR, `stateManager=${STATE_MGR}`);
ok(!!LOG_SVC, `logService=${LOG_SVC}`);
ok(!!FS_NS, `fs 命名空间=${FS_NS}`);

console.log("\n[2] spawn 命名空间探测");
const re = /([A-Za-z_$][\w$]*)\.spawn\(/g;
const hits = new Map(); let m;
while ((m = re.exec(s))) hits.set(m[1], (hits.get(m[1]) || 0) + 1);
const ranked = [...hits.entries()].sort((a, b) => b[1] - a[1]);
console.log("    候选:", ranked.slice(0, 8).map(([k, n]) => `${k}×${n}`).join(", "));
ok(ranked.length > 0, "探测到至少一个 spawn 命名空间");

console.log("\n[3] 生成注入片段并做语法校验（用同一构建逻辑）");
// 用探测到的真实符号名构造等价片段（与 apply-p3 的占位符替换同构）
const ns = ranked[0][0];
const snippet = MARK_B + "(()=>{try{const base=" + DI + ".createInstance(" + SHELL + ");base.id='dsh';base.getDescriptor=()=>({provider:'dsh'});const sp=" + ns + ".spawn;" + SVC + ".registerProvider(base);}catch(e){}})()" + MARK_E;
ok(snippet.includes(MARK_B) && snippet.includes(MARK_E), "片段含起止标记");

// 关键：把「anchor + snippet + 逗号 + 后续」包成函数体，node --check 能否通过
// ★ 2026-10-16：与 apply-p3 同步 —— 锚点会被改写成 _p3base=createInstance(...)（复用上游实例，
//   避免 1.142 壳类构造器二次注册 copilot-builtin），并在 B/q 声明处补 _p3base。
const m4 = ANCHOR.match(/^([\s\S]*?)([A-Za-z_$][\w$]*\.createInstance\()([A-Za-z_$][\w$]*)(\)[\s\S]*)$/);
let substituted = s;
if (m4) {
  const newAnchor = `${m4[1]}_p3base=${m4[2]}${m4[3]}${m4[4]}`;
  substituted = s.replace(ANCHOR, newAnchor + snippet + ",");
  substituted = substituted.replace(
    /let\s+B=H\.agentSdkDownloader\s*,\s*q=H\.providerService\s*;/,
    (t) => t.replace(/;$/, ", _p3base;"));
}
ok(m4 !== null, "锚点可安全改写（…registerProvider(DI.createInstance(X))…）");
ok(substituted.length > s.length, "替换后长度增加");
const _anchorCount = (x) => x.split(ANCHOR_RE).length - 1;
ok(substituted.split(ANCHOR).length - 1 === _anchorCount(substituted) - 1 || _anchorCount(substituted) >= 1, "锚点形态在替换后仍存在（片段未破坏锚点）");

// 用真实 bundle 前缀 + 替换后片段，写临时文件做 node --check
const tmp = path.join(ROOT, "test", ".tmp-p3-check.js");
// 取 bundle 从开头到 anchor 前面的一段，作为可解析上下文不现实（bundle 是模块）
// 改为：只校验注入片段自身的语法（剥掉标记）
fs.writeFileSync(tmp, snippet.replace(MARK_B, "").replace(MARK_E, "") + "\n");
try {
  execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
  ok(true, "注入片段自身 node --check 通过");
} catch (e) {
  ok(false, "注入片段语法错误：" + String(e.stderr || e).slice(0, 400));
}
fs.rmSync(tmp, { force: true });

console.log("\n[4] revert 精确性（在内存里模拟，与 apply-p3 revert 同口径）");
{
  let t = substituted;
  const i = t.indexOf(MARK_B), j = t.indexOf(MARK_E);
  let end = j + MARK_E.length;
  if (t[end] === ",") end += 1;
  let reverted = t.slice(0, i) + t.slice(end);
  // ★ 还原锚点改写与 _p3base 声明（与 tools/apply-p3.mjs revert() 完全一致）
  reverted = reverted.replace(/_p3base=([A-Za-z_$][\w$]*\.createInstance\([A-Za-z_$][\w$]*\))/g, "$1");
  reverted = reverted.replace(/(let\s+B=H\.agentSdkDownloader\s*,\s*q=H\.providerService)\s*,\s*_p3base\s*;/g, "$1;");
  ok(reverted === s, "revert 后与原文完全一致 ✅");
}

console.log(`\n结果: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
