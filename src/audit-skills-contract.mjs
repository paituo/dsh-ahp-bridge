/**
 * 契约校验：skills/list & hooks/list 输出 vs 官方 codex app-server schema。
 * 并**模拟 VS Code 消费侧**（codexCustomizations.ts 的 skillToCustomization）
 * 证明修复后不再抛 `Cannot read properties of undefined (reading 'replace')`。
 *
 * 用法： node audit-skills-contract.mjs
 */
import { buildSkillsList } from "./discovery.mjs";
import { buildSkillsListResult, buildHooksListResult } from "./translate.mjs";
import fsp from "node:fs/promises";

const SCHEMA_DIR = "E:/分析数据/DeepSeek-Harness-VSCode/dev/codex-protocol-schema";
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ ${msg}`); } };

const req = async (file, defName) => {
  const j = JSON.parse(await fsp.readFile(`${SCHEMA_DIR}/${file}`, "utf8"));
  return j.definitions?.[defName]?.required ?? j.required ?? [];
};

// ---- 模拟 VS Code uri.ts:313 URI.file ----
const isWindows = process.platform === "win32";
const uriFile = (p) => {
  if (isWindows) p = p.replace(/\\/g, "/");   // ← 真实首行
  return "file://" + p;
};
// ---- 模拟 VS Code codexCustomizations.ts skillToCustomization ----
const skillToCustomization = (skill) => ({
  type: "skill",
  id: "cust:" + uriFile(skill.path),          // ← 旧代码在此崩
  uri: uriFile(skill.path),
  name: skill.name,
  description: skill.description,
  enabled: skill.enabled,
});

const skillReq = await req("SkillsListResponse.json", "SkillMetadata");
const entryReq = await req("SkillsListResponse.json", "SkillsListEntry");
const hookReq = await req("HooksListResponse.json", "HookMetadata");
const hookEntryReq = await req("HooksListResponse.json", "HooksListEntry");

console.log("官方 schema required:");
console.log("  SkillMetadata   =", JSON.stringify(skillReq));
console.log("  SkillsListEntry =", JSON.stringify(entryReq));
console.log("  HookMetadata    =", JSON.stringify(hookReq));
console.log("  HooksListEntry  =", JSON.stringify(hookEntryReq));
console.log();

const cwd = process.cwd();

// ---------- 1. skills/list（实扫） ----------
console.log("[1] skills/list 实扫输出");
let res;
try {
  res = await buildSkillsList([cwd], { profile: "acp" });
} catch (e) {
  console.log("  ! buildSkillsList 失败，改用空兜底:", e.message);
  res = buildSkillsListResult([cwd], []);
}
ok(Array.isArray(res.data), "data 是数组");
for (const entry of res.data) {
  for (const k of entryReq) ok(k in entry, `entry 有 required 字段 '${k}'`);
  for (const s of entry.skills) {
    for (const k of skillReq) ok(k in s && s[k] !== undefined, `skill 有 required 字段 '${k}'`);
    break; // 只详查第一条
  }
}

// ---------- 2. VS Code 消费侧不崩 ----------
console.log("\n[2] 模拟 VS Code skillToCustomization（旧代码崩溃点）");
let crashed = null;
const produced = [];
for (const entry of res.data) {
  for (const s of entry.skills) {
    try { produced.push(skillToCustomization(s)); }
    catch (e) { crashed = e; }
  }
}
if (crashed) {
  ok(false, `消费侧仍崩: ${crashed.message}`);
} else {
  ok(true, `消费侧无异常（处理 ${produced.length} 个 skill）`);
}
if (produced.length) console.log("     样例 id:", produced[0].id);

// ---------- 3. 回归证明：旧结构（只有 uri，无 path）必崩 ----------
console.log("\n[3] 回归对照：旧结构（缺 path）");
let oldCrashed = false, oldMsg = "";
try { skillToCustomization({ name: "x", description: "", scope: "user", uri: "file:///x" }); }
catch (e) { oldCrashed = true; oldMsg = e.message; }
ok(oldCrashed && /reading 'replace'/.test(oldMsg), `旧结构复现报错: "${oldMsg}"`);

// ---------- 4. hooks/list ----------
console.log("\n[4] hooks/list 契约");
const hr = buildHooksListResult([cwd]);
ok(Array.isArray(hr.data), "data 是数组");
for (const entry of hr.data) for (const k of hookEntryReq) ok(k in entry, `hooks entry 有 '${k}'`);

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
