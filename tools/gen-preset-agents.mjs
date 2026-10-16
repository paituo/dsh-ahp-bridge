#!/usr/bin/env node
/**
 * 把 DSH preset 落盘成 VS Code 可发现的 *.agent.md 文件。
 *
 * 背景（2026-10-11 根因链，全部 bundle 实证）：
 *   agent picker 的真实数据源 = agentHost harness.itemProvider.provideCustomAgents
 *     = (await promptsService.getCustomAgents(e)).filter(n => rw(n.sessionTypes, Li(o)))
 *   其中：
 *     · Li(o)              = 会话 resource 的 scheme（= provider id，如 agenthost-dsh）
 *     · promptsService     = **VS Code 自己的 prompt 文件发现**（扫 .github/agents 等）
 *     · rw(s,o)            = s===undefined || o===undefined || s.includes(o)
 *   ⇒ 桥的 provider.getCustomAgents **不参与 picker 渲染**（只用于 _initAgent 恢复已选）
 *   ⇒ 要让 preset 出现在 picker，必须落盘成 *.agent.md
 *
 * 用法：
 *   node tools/gen-preset-agents.mjs [--dir <工作区>] [--write]
 *   默认 dry-run（只打印），加 --write 才落盘。
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const WRITE = argv.includes("--write");
const dirIdx = argv.indexOf("--dir");
const WORKSPACE = dirIdx >= 0 ? argv[dirIdx + 1] : "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30";

/** DSH preset 清单（与 bridge/src/presets.mjs 的 SHIPPED_DISPLAY 一致 + liangshen）。 */
const PRESETS = [
  {
    id: "standard",
    name: "标准模式",
    description: "处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。",
    order: 1,
  },
  {
    id: "ptc",
    name: "PTC 模式",
    description: "包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。",
    order: 2,
  },
  {
    id: "minimal",
    name: "极简模式",
    description: "Agent 仅使用终端工具完成任务，适合测试和对比其基础表现。",
    order: 3,
  },
  {
    id: "cordis",
    name: "创作者模式",
    description: "用对话定制 DSH：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。",
    order: 4,
  },
  {
    id: "liangshen",
    name: "梁神模式",
    description: "LiangShen 预设（第三方插件 @linxin666/dsh-liangshen）。",
    order: 5,
  },
  {
    id: "orchestrator",
    name: "编排模式 (Orchestrator)",
    description: "Orchestrator 预设（来自 ~/.dsh/.agent-presets）。用于编排/多步任务流程。",
    order: 6,
  },
];

/** 生成 agent.md 内容。
 *
 * frontmatter 字段参照真机样例（Copilot 的 Ask.agent.md）：
 *   name / description / argument-hint / target / disable-model-invocation / tools / agents
 * 另加 sessionTypes（bundle 的 fromParsedPromptFile 支持该字段，值为 scheme 字符串数组）。
 *
 * ★ sessionTypes 取值（2026-10-15 纠正 —— 曾写错为 "agenthost-dsh"）：
 *   _In 的过滤基准 `a = WZi(e) ?? e`，而 `WZi(s) = s.startsWith(fon) ? s.slice(fon.length) : TZ(s)`，
 *   其中 `fon = "agent-host-"`（sessions.desktop.main.js:4030370）。
 *   ⇒ 会话 scheme `agent-host-dsh` 经 WZi 后 = **"dsh"**（剥离前缀）。
 *   ⇒ sessionTypes 必须填 **["dsh"]**；填 ["agenthost-dsh"] 会**永不匹配**。
 *   （`TZ` 仅对 `remote-` 前缀生效：`ow(s)=s.startsWith("remote-")`；本地 scheme 走 fon 分支。）
 *   若留空（不写该字段）⇒ rw(undefined, ...) = true ⇒ 所有 provider 的 picker 都显示。
 *   本脚本默认**不写** sessionTypes（广泛可见，便于先验证机制），可用 --scope=dsh 收窄。
 */
function render(preset, scope) {
  const lines = ["---"];
  lines.push(`name: ${preset.name}`);
  lines.push(`description: ${preset.description}`);
  lines.push(`argument-hint: DSH preset: ${preset.id}`);
  lines.push(`target: vscode`);
  if (scope === "dsh") lines.push(`sessionTypes: ["dsh"]`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${preset.name}`);
  lines.push("");
  lines.push(`本模式由 DSH（DeepSeek Harness）preset \`${preset.id}\` 映射而来。`);
  lines.push("");
  lines.push("> ⚠️ 该出现在 VS Code 侧仅作为「模式标签」；真正启用 DSH preset 需在 DSH 侧切换。");
  lines.push("");
  return lines.join("\n");
}

const scopeIdx = argv.findIndex((a) => a.startsWith("--scope="));
const SCOPE = scopeIdx >= 0 ? argv[scopeIdx].split("=")[1] : "all";

// ★ 输出目录（2026-10-15 修正 —— 致命根因修复）：
//   默认落到 **`~/.dsh-agents`**（**默认扫描集合之外的新 ~/ 目录**）。
//
//   ⚠️⚠️ 为什么不能再落 `~/.copilot/agents`（血的教训，源码级证据）：
//     1) picker 链 = Vye.provideCustomAgents → _customAgentsService(eRt scope) → xIn() 本地扫描
//        （sessions.desktop.main.js:21000262 / 21002530 / 7673162）
//     2) eRt 由 acquireScope(scheme, roots) 创建，其 includeUserStorage =
//        `ow(scheme)` = `scheme.startsWith("remote-")` ⇒ 对本地 `agent-host-dsh` **恒为 false**
//        （sessions.desktop.main.js:7677126 + 4030616）
//     3) xIn 的 storage 白名单 `c = includeUserStorage ? ["user",...Lmo] : Lmo`
//        （Lmo = ["plugin","extension","builtin"]）⇒ **不含 "user"**
//     4) 放行条件：`c.includes(f) || source==="config-workspace" || source==="config-personal"`
//        —— `~/.copilot/agents` 的 source 是 **"copilot-personal"**（KCr @4163001），**两个都不满足**
//        ⇒ 文件被 **100% 过滤掉** ⇒ picker 为空。
//     5) 而 `~/.copilot/agents` **在 `V`（默认集合）里**，即使写进 chat.agentFilesLocations
//        也会被 `V.has(K) ⇒ continue` 跳过（@4168609）⇒ 仍是 copilot-personal ⇒ 无效。
//
//   ⇒ 唯一零注入解法：**用一个默认集合之外的新 `~/` 目录**，写进
//      `chat.agentFilesLocations`（settings.json），使其被注册为
//      `{source:"config-personal", storage:"user"}`（因路径以 `~/` 开头，`Awt(s)=s.startsWith("~/")`）
//      ⇒ **满足放行条件第二项** ⇒ 过闸门 ✅
//
//   落地三件套（缺一不可）：
//     a) 本工具把 preset 写到 `~/.dsh-agents`（--write）
//     b) settings.json 加 `"chat.agentFilesLocations": { "~/.dsh-agents": true }`
//     c) 重启 VS Code
//
//   ⚠️ 仍要避免同名重复：不要把这批文件同时放到 `.github/agents`（工作区）等也会被扫的目录。
const outIdx = argv.findIndex((a) => a === "--out");
const HOME = process.env.USERPROFILE || process.env.HOME || "C:/Users/liuyue";
const outDir = outIdx >= 0
  ? argv[outIdx + 1]
  : path.join(HOME, ".dsh-agents");
console.log(`工作区(仅记录): ${WORKSPACE}`);
console.log(`输出目录: ${outDir}`);
console.log(`sessionTypes 范围: ${SCOPE === "dsh" ? "[\"dsh\"]（仅 DSH 可见；注意是剥离 agent-host- 前缀后的值）" : "不限（所有 provider 可见）"}`);
console.log(`模式: ${WRITE ? "★ 写入" : "dry-run（仅打印）"}\n`);

if (WRITE) fs.mkdirSync(outDir, { recursive: true });
for (const p of PRESETS) {
  const file = path.join(outDir, `dsh-${p.id}.agent.md`);
  const content = render(p, SCOPE);
  console.log(`--- ${file} ---`);
  console.log(content.split("\n").slice(0, 8).join("\n"));
  console.log("...\n");
  if (WRITE) fs.writeFileSync(file, content, "utf8");
}
console.log(WRITE ? `✅ 已写入 ${PRESETS.length} 个 agent 文件` : `（dry-run，加 --write 落盘）`);
