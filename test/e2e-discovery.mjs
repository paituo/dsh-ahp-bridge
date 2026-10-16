#!/usr/bin/env node
/**
 * 发现器测试 —— 验证桥补齐的两处缺口：
 *   1) skills/list 真能扫出 DSH 真实技能目录里的技能
 *   2) mcpServerStatus/list 真能解析 profile 的 dsh-mcp-client 条目
 *
 * 用法: node test/e2e-discovery.mjs
 */
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { buildSkillsList, discoverMcpServers, resolveSkillRoots, parseMcpEntriesFromYaml } from "../src/discovery.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

const agentsHome = path.join(os.homedir(), ".agents");

console.log("\n[1] 技能根目录解析");
{
  const roots = await resolveSkillRoots(path.join(os.homedir(), "WorkBuddy"));
  const srcs = roots.map((r) => r.source);
  console.log("    roots:", roots.map((r) => `${r.source}(${r.scope})`).join(", "));
  ok(roots.some((r) => r.source === "user-agents"), "包含用户级 user-agents 根");
  ok(roots.some((r) => r.source === "project-dsh"), "包含项目级 project-dsh 根");
}

console.log("\n[2] skills/list —— 扫真实技能目录");
{
  const res = await buildSkillsList([path.join(os.homedir(), "WorkBuddy")], { agentsHome });
  const total = res.data.reduce((n, g) => n + g.skills.length, 0);
  ok(res.data.length === 1, `返回 1 个 cwd 分组`);
  ok(total > 0, `扫出技能数 > 0（实际 ${total}）`);
  const sample = res.data[0].skills.slice(0, 8);
  console.log("    前 8 个:");
  for (const s of sample) console.log(`      - ${s.name}  [${s.scope}]  ${(s.description || "(无描述)").slice(0, 60)}`);
  const named = res.data[0].skills.find((s) => s.name === "codex-cli-calling");
  ok(!!named, "含 ~/.agents/skills 下的 codex-cli-calling");
  ok(named && named.description.length > 0, "  ↑ 其 description 已从 front-matter 解析");
  ok(named && named.uri && named.uri.startsWith("file:///"), "  ↑ 其 uri 是 file:// 形态");
  ok(named && named.scope === "user", "  ↑ 其 scope=user");
}

console.log("\n[3] mcpServerStatus/list —— 解析 DSH profile 条目");
{
  const { servers } = await discoverMcpServers("acp");
  ok(Array.isArray(servers), "返回数组");
  console.log(`    本机 profile 发现 ${servers.length} 个 MCP server（本机未声明则为 0，属正常）`);
  for (const s of servers.slice(0, 6)) console.log(`      - ${s.name}  [${s.transport}]  ${s.command ?? s.url ?? ""}`);
}

console.log("\n[3b] MCP YAML 解析器 —— 合成样例（证明解析逻辑可用）");
{
  const synth = [
    "# patch layer",
    "- name: '@deepseek-ai/dsh-mcp-client'",
    "  config:",
    "    serverName: github",
    "    transport: stdio",
    "    command: npx",
    "    args: ['-y', '@modelcontextprotocol/server-github']",
    "- name: '@deepseek-ai/dsh-mcp-client'",
    "  config:",
    "    serverName: web",
    "    transport: streamable-http",
    "    url: http://localhost:3000/mcp",
  ].join("\n");
  const parsed = parseMcpEntriesFromYaml(synth, "<synthetic>");
  ok(parsed.length === 2, `解析出 2 个条目（实际 ${parsed.length}）`);
  const gh = parsed.find((s) => s.name === "github");
  const web = parsed.find((s) => s.name === "web");
  ok(!!gh && gh.transport === "stdio" && gh.command === "npx", "github: stdio + command=npx");
  ok(!!gh && Array.isArray(gh.args) && gh.args.length === 2, "github: args 解析为 2 项");
  ok(!!web && web.transport === "streamable-http" && web.url === "http://localhost:3000/mcp", "web: streamable-http + url");
}

console.log("\n[4] 空目录 / 不存在的 cwd 不炸");
{
  const res = await buildSkillsList(["C:/__no_such_dir__"], { agentsHome });
  ok(res.data.length === 1, "仍返回结构");
  ok(Array.isArray(res.data[0].skills), "skills 是数组");
}

console.log("\n[5] ★ 回归：args 三种写法都要解析出来（2026-10-11 血案）");
{
  // 血案：旧实现只认 `args: [...]` 行内形式，块序列/折叠标量的 args 静默丢失
  //   ⇒ 桥把「缺 args 的 stdio server」交给 DSH ⇒ 子进程起不来 ⇒ thread/start 静默挂死。
  const t1 = ["- config:", "    serverName: a", '    args: ["-y","pkg"]'].join("\n");
  const t2 = ["- config:", "    serverName: b", "    args:", '      - "-y"', '      - "pkg"'].join("\n");
  const t3 = ["- config:", "    serverName: c", "    args:", "      - >-", "        C:/long/path/x.mjs"].join("\n");
  // DSH 自动生成 cordis.yml 时用的正是 t3 形态
  const r1 = parseMcpEntriesFromYaml(t1, "x")[0];
  const r2 = parseMcpEntriesFromYaml(t2, "x")[0];
  const r3 = parseMcpEntriesFromYaml(t3, "x")[0];
  ok(JSON.stringify(r1?.args) === '["-y","pkg"]', "① 行内流式 → 2 项");
  ok(JSON.stringify(r2?.args) === '["-y","pkg"]', "② 块序列 → 2 项");
  ok(JSON.stringify(r3?.args) === '["C:/long/path/x.mjs"]', "③ 折叠标量(>-) → 1 项");
}

console.log("\n[6] ★ 回归：不把 merged 产物 cordis.yml 当配置源（去重）");
{
  // 血案：cordis.yml 是 DSH 合并 base/acp-app/用户 patch 后的产物，
  //   与 cordis.patch.yml 会重复计入同一个 server ⇒ 同名两条。
  const res = await discoverMcpServers("acp", {});
  const names = res.servers.map((s) => s.name);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  ok(dup.length === 0, `无同名重复（实际重复: ${dup.join(",") || "无"}）`);
  for (const s of res.servers) {
    ok(!/cordis\.yml$/.test(s.source ?? ""), `${s.name}: source 不是 merged 产物`);
  }
}

console.log("\n[7] ★ 回归：技能 front-matter 的四种标量写法（2026-10-11 血案）");
{
  // 血案：真实技能的 description 大量使用折叠标量 `>`，
  //   旧实现逐行 `key: value` 处理 ⇒ 把 `>` 当字面值 ⇒ description 变成 ">"（长度 1）
  //   实测受影响：rpd（真实技能，27KB）、以及任何多行描述技能 ⇒ VS Code 面板描述丢失。
  const { parseFrontMatterForTest } = await import("../src/discovery.mjs");
  const fm = parseFrontMatterForTest([
    "---",
    "name: demo",
    "description: >",
    "  line one about the skill purpose",
    "  line two continues here",
    "other: plain",
    "literal: |",
    "  raw one",
    "  raw two",
    "---",
    "# body",
  ].join("\n"));
  ok(fm.name === "demo", "① 单行标量正确");
  ok(typeof fm.description === "string" && fm.description.length > 40,
    `② 折叠标量(>) 解析为完整多行文本（实际 len=${(fm.description ?? "").length}）`);
  ok(/line one about the skill purpose line two continues here/.test(fm.description ?? ""),
    "③ 折叠语义：多行以空格连接");
  ok(fm.literal === "raw one\nraw two", "④ 字面标量(|) 保留换行");
  ok(fm.other === "plain", "⑤ 普通标量不受影响");
  ok(fm.name !== ">" && fm.description !== ">", "⑥ 不再把 > 当字面值");
}

console.log("\n[8] ★ 回归：真实技能 description 非空（端到端）");
{
  const r = await buildSkillsList([process.cwd()]);
  const all = r.data.flatMap((g) => g.skills);
  const empty = all.filter((s) => !s.description || s.description.trim().length < 5);
  ok(empty.length === 0,
    `所有真实技能都有有效 description（空/过短: ${empty.map((s) => s.name).join(",") || "无"}）`);
  const rpd = all.find((s) => s.name === "rpd");
  if (rpd) ok(rpd.description.length > 100, `rpd 的折叠标量描述已完整（len=${rpd.description.length}）`);
  console.log(`    （本机共 ${all.length} 个技能：${all.map((s) => s.name).join(", ")}）`);
}

console.log(`\n结果: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
