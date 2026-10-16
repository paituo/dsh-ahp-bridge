/**
 * 技能（skills）可用性实测 —— VS Code 视角
 *
 * 关键问题：VS Code 里「可用技能」应包含三类来源
 *   ① VS Code 内置技能（安装目录 vs/sessions/skills/*，13 个）
 *   ② 工作区技能（<proj>/.dsh/skills、<proj>/.agents/skills）
 *   ③ 用户级技能（~/.dsh/skills、~/.agents/skills）
 * 桥的实现只扫 ②③（DSH 同源目录）。
 *
 * 本脚本：真实起桥 → 调 skills/list → 与磁盘真实技能全集逐一比对，量化覆盖率。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { vscodeSkillsDir } from "../tools/vscode-locate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, "..", "src", "bridge.mjs");
const NODE = process.execPath;
const DSH_BIN = "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";
const CWD = "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30";
const VS_SKILLS = vscodeSkillsDir();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  OK   ${m}`); } else { fail++; console.log(`  MISS ${m}`); } };

/** 磁盘真实技能全集（不含 VS Code 内置） */
function scanDiskSkills() {
  const out = new Map();
  const roots = [
    { p: path.join(CWD, ".dsh", "skills"), src: "project-dsh" },
    { p: path.join(CWD, ".agents", "skills"), src: "project-agents" },
    { p: path.join(os.homedir(), ".dsh", "skills"), src: "user-dsh" },
    { p: path.join(os.homedir(), ".agents", "skills"), src: "user-agents" },
  ];
  for (const r of roots) {
    if (!fs.existsSync(r.p)) continue;
    for (const e of fs.readdirSync(r.p, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) {
        if (fs.existsSync(path.join(r.p, e.name, "SKILL.md"))) out.set(e.name, r.src);
        else for (const s of fs.readdirSync(path.join(r.p, e.name), { withFileTypes: true })) {
          if (s.isDirectory() && fs.existsSync(path.join(r.p, e.name, s.name, "SKILL.md"))) out.set(s.name, r.src);
        }
      } else if (e.name.endsWith(".md") && e.name !== "SKILL.md") out.set(e.name.replace(/\.md$/, ""), r.src);
    }
  }
  return out;
}

let child, buf = "", id = 0;
const pending = new Map();
function send(method, params, timeoutMs = 120000) {
  const mid = ++id;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
  return new Promise((res, rej) => {
    pending.set(mid, { res, rej });
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error("timeout " + method)); } }, timeoutMs);
  });
}
function onLine(line) {
  let x; try { x = JSON.parse(line); } catch { return; }
  if (x.id && pending.has(x.id)) {
    const { res, rej } = pending.get(x.id); pending.delete(x.id);
    x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result);
  }
}

(async () => {
  child = spawn(NODE, [BRIDGE, "--provider-id", "dsh", "--dsh-bin", DSH_BIN, "--cwd", CWD], {
    cwd: CWD, stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); onLine(l); }
  });
  child.stderr.on("data", (d) => { const s = String(d); if (/skills|error/i.test(s)) process.stderr.write("[桥] " + s); });

  const init = await send("initialize", { protocolVersion: 1, clientCapabilities: {} });
  console.log("=== (1) initialize 能力宣告 ===");
  console.log("  capabilities:", JSON.stringify(init.capabilities));
  ok("宣称支持 skills", init.capabilities?.skills === true);

  console.log("\n=== (2) skills/list（VS Code 面板数据源）===");
  const res = await send("skills/list", { cwds: [CWD] });
  const groups = res.data ?? [];
  const bridgeSkills = groups.flatMap((g) => g.skills ?? []);
  console.log("  分组数:", groups.length, "| 技能总数:", bridgeSkills.length);
  for (const g of groups) {
    console.log(`  cwd=${g.cwd}  ->  ${g.skills.length} 个`);
    for (const s of g.skills.slice(0, 8)) console.log(`     · ${s.name} [${s.scope}/${s.source}]`);
    if (g.skills.length > 8) console.log(`     ... 其余 ${g.skills.length - 8} 个`);
  }

  console.log("\n=== (3) 结构合规性 ===");
  const bad = bridgeSkills.filter((s) => !s.name || !s.scope || !s.uri);
  ok("每项都有 name/scope/uri", bad.length === 0, bad.length ? JSON.stringify(bad[0]) : "全部合规");
  const noDesc = bridgeSkills.filter((s) => !s.description);
  console.log(`  无 description 的项: ${noDesc.length} ${noDesc.length ? "-> " + noDesc.map((s) => s.name).slice(0, 5).join(", ") : ""}`);

  console.log("\n=== (4) 与磁盘真实技能比对（覆盖率）===");
  const disk = scanDiskSkills();
  const bridgeNames = new Set(bridgeSkills.map((s) => s.name));
  const diskNames = new Set(disk.keys());
  const missing = [...diskNames].filter((n) => !bridgeNames.has(n));
  const extra = [...bridgeNames].filter((n) => !diskNames.has(n));
  console.log(`  磁盘真实技能: ${diskNames.size} 个`);
  console.log(`  桥上报技能  : ${bridgeNames.size} 个`);
  console.log(`  漏报        : ${missing.length} ${missing.length ? "-> " + missing.slice(0, 10).join(", ") : ""}`);
  console.log(`  多报        : ${extra.length} ${extra.length ? "-> " + extra.slice(0, 10).join(", ") : ""}`);
  ok("无漏报（磁盘 -> 桥）", missing.length === 0);
  ok("无多报（桥 -> 磁盘）", extra.length === 0);

  console.log("\n=== (5) VS Code 内置技能覆盖（关键缺口探测）===");
  const vsBuiltin = fs.existsSync(VS_SKILLS)
    ? fs.readdirSync(VS_SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];
  console.log(`  VS Code 内置技能: ${vsBuiltin.length} 个 -> ${vsBuiltin.join(", ")}`);
  const covered = vsBuiltin.filter((n) => bridgeNames.has(n));
  console.log(`  其中被桥上报: ${covered.length} 个`);
  console.log(`  未被桥上报  : ${vsBuiltin.length - covered.length} 个`);
  ok("桥覆盖 VS Code 内置技能", covered.length === vsBuiltin.length,
    covered.length === vsBuiltin.length ? "全覆盖" : `缺 ${vsBuiltin.length - covered.length} 个（桥不扫 VS Code 安装目录）`);

  console.log("\n=== (6) 来源分布统计 ===");
  const bySource = {};
  for (const s of bridgeSkills) bySource[s.source] = (bySource[s.source] ?? 0) + 1;
  console.log("  ", JSON.stringify(bySource));

  console.log(`\n结果: ${pass} passed, ${fail} failed`);
  child.kill();
  process.exit(0);
})().catch((e) => { console.error("ERR", e.message); child?.kill(); process.exit(1); });
