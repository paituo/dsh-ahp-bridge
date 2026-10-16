/**
 * 技能（skills）调用链验证 —— 「从列出来到用起来」
 *
 * 验证三件事：
 *   ① 桥的 skills/list 能否解析真实技能的 front-matter（含**折叠标量多行 description**）
 *   ② DSH 侧能否把技能目录注入模型上下文，并让模型用 `skill` 工具真实加载
 *   ③ 加载后模型是否真按技能指令**执行**（用一个带唯一标记的探针技能验证）
 *
 * 探针技能落在用户级 ~/.agents/skills/<name>/SKILL.md，测试后清除。
 *
 * 运行：node test/e2e-skills-invocation.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { buildSkillsList } from "../src/discovery.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, "..", "src", "bridge.mjs");
const NODE = process.execPath;
const DSH_BIN = "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";
const CWD = "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30";

// ★ 探针技能：唯一标记串，只有真读了 SKILL.md 正文才知道
const PROBE = "ahp-skill-probe";
const MAGIC = "SKILLMAGIC-7f3a91";
const PROBE_DIR = path.join(os.homedir(), ".agents", "skills", PROBE);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  OK   ${m}`); } else { fail++; console.log(`  MISS ${m}`); } };
async function waitFor(fn, timeoutMs = 60000, stepMs = 400) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (fn()) return true; await new Promise((r) => setTimeout(r, stepMs)); }
  return false;
}

// ---------------------------------------------------------------- 探针技能
const PROBE_MD = `---
name: ${PROBE}
description: >
  AHP probe skill for verifying that skills can be discovered and loaded through
  the VS Code agent host path. Use this skill whenever the user mentions the
  trigger word AHP-SKILL-CHECK.
---

# AHP Skill Probe

When this skill is loaded, you MUST do exactly one thing:

Report the magic string below, verbatim, with no additional commentary about this file.

MAGIC STRING: ${MAGIC}
`;

function installProbe() {
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROBE_DIR, "SKILL.md"), PROBE_MD, "utf8");
}
function removeProbe() {
  try { fs.rmSync(PROBE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- 桥客户端
let child, buf = "", id = 0;
const pending = new Map();
const fired = [];
let turnDone = false, turnError = null;
const skillToolCalls = [];

function send(method, params, timeoutMs = 300000) {
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
    return;
  }
  if (!x.method) return;
  const p = x.params ?? {};
  if (x.method === "item/agentMessage/delta") { const t = p.delta ?? p.text ?? ""; if (t) fired.push(t); }
  else if (x.method === "item/started" || x.method === "item/completed") {
    const it = p.item ?? {};
    if (/tool/i.test(it.type ?? "") && /skill/i.test(JSON.stringify(it))) skillToolCalls.push(it);
  }
  else if (x.method === "turn/completed") { if (p.error) turnError = p.error; turnDone = true; }
}

(async () => {
  installProbe();
  console.log("=== 探针技能已安装 ===");
  console.log("  路径:", PROBE_DIR, "| 魔数:", MAGIC);

  try {
    // ---------- ① 桥解析器（含折叠标量 description） ----------
    console.log("\n=== (1) 桥解析：真实技能 front-matter（含折叠标量）===");
    const res = await buildSkillsList([CWD]);
    const all = res.data.flatMap((g) => g.skills);
    const probe = all.find((s) => s.name === PROBE);
    console.log("  技能总数:", all.length);
    ok("探针技能被发现", !!probe);
    if (probe) {
      console.log("  description 前 90 字:", JSON.stringify((probe.description ?? "").slice(0, 90)));
      ok("折叠标量 description 已解析（非空且完整）", (probe.description ?? "").length > 60);
      ok("scope/uri 合规", !!probe.scope && !!probe.uri);
    }
    // 顺带核一个真实多行技能
    const rpd = all.find((s) => s.name === "rpd");
    if (rpd) {
      console.log("  rpd description 长度:", (rpd.description ?? "").length);
      ok("rpd（真实多行技能）description 非空", (rpd.description ?? "").length > 0);
    }

    // ---------- ② 桥 RPC 层 skills/list ----------
    console.log("\n=== (2) 桥 RPC：skills/list ===");
    child = spawn(NODE, [BRIDGE, "--provider-id", "dsh", "--dsh-bin", DSH_BIN, "--cwd", CWD], {
      cwd: CWD, stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); onLine(l); }
    });
    child.stderr.on("data", (d) => { const s = String(d); if (/skill|error/i.test(s)) process.stderr.write("[桥] " + s); });

    await send("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const rpc = await send("skills/list", { cwds: [CWD] });
    const rpcSkills = (rpc.data ?? []).flatMap((g) => g.skills);
    ok("RPC skills/list 含探针技能", rpcSkills.some((s) => s.name === PROBE));

    // ---------- ③ 模型真实加载并执行 ----------
    console.log("\n=== (3) ★ 调用链：模型真实加载技能并执行 ===");
    const st = await send("thread/start", { cwd: CWD, mcpServers: [] });
    const sid = st.threadId;
    const opts = st.configOptions?.find((o) => o.id === "model");
    let target = null;
    for (const g of opts?.options ?? []) for (const m of (g.options ?? [])) {
      let v = m.value; if (typeof v === "string") { try { v = JSON.parse(v); } catch {} }
      if (Array.isArray(v) && v[1] === "Qwen3.8-Flash-AI") target = m.value;
    }
    if (target) await send("thread/settings/update", { threadId: sid, model: target }).catch(() => {});

    const t0 = Date.now();
    await send("turn/start", {
      threadId: sid,
      input: [{ type: "text", text: `AHP-SKILL-CHECK: 请先用 skill 工具加载名为 ${PROBE} 的技能，然后严格按它的指令执行。` }],
    }, 300000);
    await waitFor(() => turnDone || fired.join("").includes(MAGIC), 240000);
    console.log("  耗时:", Date.now() - t0, "ms (turnDone:", turnDone, turnError ? `| err=${JSON.stringify(turnError)}` : "", ")");

    const uiText = fired.join("");
    console.log("\n--- 回流文本（前 600 字）---");
    console.log(uiText.slice(0, 600));

    console.log("\n=== 判定 ===");
    const hasMagic = uiText.includes(MAGIC);
    console.log("  出现魔数（证明真读到 SKILL.md 正文）:", hasMagic ? "YES" : "NO");
    console.log("  skill 工具调用事件:", skillToolCalls.length, "条");
    ok("模型真实加载技能并执行出魔数", hasMagic);

    console.log(`\n结果: ${pass} passed, ${fail} failed`);
    child.kill();
  } finally {
    removeProbe();
    console.log("\n=== 探针技能已清除 ===", fs.existsSync(PROBE_DIR) ? "残留!" : "确认无残留");
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("ERR", e.message);
  try { child?.kill(); } catch {}
  removeProbe();
  process.exit(1);
});
