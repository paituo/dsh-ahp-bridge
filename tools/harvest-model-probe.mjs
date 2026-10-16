#!/usr/bin/env node
/**
 * 探针收割器 v2 —— 从 **VS Code agenthost.log**（桥 stderr 的真实落点）抽探针打点。
 *
 * ★ 为什么改默认源（2026-10-16）：
 *   桥 stderr 经 `codex-ext.exe` 直通 VS Code 管道，**不写文件**；
 *   VS Code 把它转发进 `%APPDATA%\Code\logs\<ts>\agenthost.log`（带 `[Codex stderr]` 前缀）。
 *   故真实数据在 agenthost.log，而不是 bridge/temp/inject-bridge.log（那是旧的直跑日志）。
 *
 * 用法：
 *   node tools/harvest-model-probe.mjs                 # 自动取最新 agenthost.log
 *   node tools/harvest-model-probe.mjs <日志路径>
 *   node tools/harvest-model-probe.mjs --last          # 只看最后一次 bridge up 之后
 *   node tools/harvest-model-probe.mjs --tags probe-turn   # 只看某类探针
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 自动定位最新的 VS Code agenthost.log */
function newestAgentHostLog() {
  const roots = [
    join(homedir(), "AppData", "Roaming", "Code", "logs"),
    join(homedir(), "AppData", "Roaming", "Code - Insiders", "logs"),
  ];
  for (const root of roots) {
    try {
      const dirs = readdirSync(root)
        .map((d) => ({ p: join(root, d), t: statSync(join(root, d)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const { p } of dirs) {
        const f = join(p, "agenthost.log");
        try { if (statSync(f).size > 0) return f; } catch { /* next */ }
      }
    } catch { /* next root */ }
  }
  return null;
}

const argv = process.argv.slice(2);
const pathArg = argv.find((a) => !a.startsWith("--"));
const tagArg = argv.includes("--tags") ? argv[argv.indexOf("--tags") + 1] : null;
const lastOnly = argv.includes("--last");

const DEFAULT_FALLBACK = join(__dirname, "..", "temp", "inject-bridge.log");
const logPath = pathArg ? resolve(pathArg) : (newestAgentHostLog() ?? DEFAULT_FALLBACK);

let text;
try { text = readFileSync(logPath, "utf8"); }
catch (e) { console.error(`读日志失败：${logPath}\n${e?.message ?? e}`); process.exit(1); }

const lines = text.split(/\r?\n/);
const TAG_RE = /\[(probe-model|probe-turn)\]\s+T=(\d+)\/([\d.]+)\s+(\S+)\s+(.*)$/;
const hits = [];
let lastBridgeUp = -1;
lines.forEach((ln, i) => {
  if (/\[bridge\] info: bridge up/.test(ln)) lastBridgeUp = i;
  const m = ln.match(TAG_RE);
  if (!m) return;
  hits.push({ idx: i, family: m[1], wall: Number(m[2]), mono: Number(m[3]), tag: m[4], rest: m[5] });
});

let sel = hits;
if (tagArg) sel = sel.filter((h) => h.family === tagArg);
if (lastOnly && lastBridgeUp >= 0) sel = sel.filter((h) => h.idx > lastBridgeUp);

console.log(`\n=== 探针时间线（${sel.length} 条）===\n源：${logPath}`);
if (lastBridgeUp >= 0) console.log(`（--last 基准：最后 bridge up @行 ${lastBridgeUp + 1}）`);
console.log("");

if (!sel.length) {
  console.log("（无打点）可能原因：");
  console.log("  · 桥未重启（VS Code 需完全退出后重开，仅关窗口不够）");
  console.log("  · 运行的是旧代码（确认 launcher.conf 的 BRIDGE_SCRIPT = E:\\...\\dev\\dsh-ahp-bridge\\bridge\\src\\bridge.mjs）");
  console.log("  · 本轮尚未产生会话/轮次");
  process.exit(0);
}

const base = sel[0].mono;
for (const h of sel) {
  const rel = (h.mono - base).toFixed(1).padStart(9);
  const wall = new Date(h.wall).toISOString().slice(11, 23);
  console.log(`${wall} +${rel}ms  ${h.family === "probe-turn" ? "P5" : h.tag.padEnd(4)} ${h.rest}`);
}

// ---------------- 自动裁决 ----------------
console.log("\n=== 自动裁决 ===\n");
const p1req = sel.filter((h) => /session\/new REQ/.test(h.rest));
const p1resp = sel.filter((h) => /session\/new RESP/.test(h.rest));
const p5 = sel.filter((h) => h.family === "probe-turn");
const p5msg = p5.filter((h) => /agent_message_chunk/.test(h.rest));

if (p1req.length) {
  console.log(`[1] session/new ${p1req.length} 次，全部 hasModelField=false ⇒ 桥不传模型（DSH 用 pinned 默认）`);
}
if (p1resp.length) {
  for (const h of p1resp) {
    const m = h.rest.match(/currentModel=(.*?)\s+modelCount/);
    console.log(`[2] DSH 建会话回执 currentModel = ${m ? m[1] : "?"}`);
  }
}
if (p5.length) {
  console.log(`[3] P5 session/update 共 ${p5.length} 条；其中 agent_message_chunk ${p5msg.length} 条`);
  const kinds = {};
  for (const h of p5) { const k = (h.rest.match(/kind=(\S+)/) ?? [])[1] ?? "?"; kinds[k] = (kinds[k] ?? 0) + 1; }
  console.log(`    kind 分布：${JSON.stringify(kinds)}`);
  if (p5msg.length) {
    const withStarted = p5msg.filter((h) => /item\/started/.test(h.rest));
    console.log(`    ⇒ ✅ DSH 确实回传了助手文本（${p5msg.length} 块）；修复后其中 ${withStarted.length} 条翻成 item/started`);
    console.log(`       ⇒ 若 VS Code 仍空白，问题在 renderer 之外的注入层（reflow/markdown），不在桥。`);
  } else {
    console.log(`    ⇒ ⚠️ **DSH 全程未回 agent_message_chunk** ⇒ 无助手文本产出，`);
    console.log(`       根源在模型/网关（凭据、IP 白名单、模型可用性），不在桥的翻译层。`);
  }
}
// ★★★ [4] 模型一致性裁决（2026-10-16，修「选 A 跑 B」的核心判据）
const p6req = sel.filter((h) => /set_config_option REQ/.test(h.rest));
const p6resp = sel.filter((h) => /set_config_option RESP/.test(h.rest));
const p6err = sel.filter((h) => /set_config_option ERR/.test(h.rest));
if (p6req.length || p6resp.length || p6err.length) {
  console.log(`[4] ★ 模型下发：REQ ${p6req.length} 次 / RESP ${p6resp.length} 次 / ERR ${p6err.length} 次`);
  for (const h of p6req) {
    const v = (h.rest.match(/value=(.*?)\s*$/) ?? [])[1];
    console.log(`    下发 → ${v}`);
  }
  for (const h of p6resp) {
    const v = (h.rest.match(/value=(.*?)\s+DSH回读=/) ?? [])[1];
    const b = (h.rest.match(/DSH回读=(.*?)\s+(✅|❌)/) ?? [])[1];
    const ok = /✅/.test(h.rest);
    console.log(`    回读 ← 请求=${v} DSH实际=${b} ${ok ? "✅ 匹配" : "❌ 不匹配 ⇒ DSH 未采纳，用户选择被静默丢弃"}`);
  }
  for (const h of p6err) {
    const m = (h.rest.match(/ERR value=(.*?) code=(\S+) msg=(.*)$/) ?? []);
    console.log(`    ❌ 下发失败 value=${m[1]} code=${m[2]} msg=${m[3]}`);
  }
  if (!p6req.length) {
    console.log(`    ⇒ ⚠️ 桥**从未下发** set_config_option ⇒ 桥侧 __model 为空或解析失败，`);
    console.log(`       DSH 只能用 pinned 默认模型（这就是「选了不生效」）。`);
  }
} else {
  console.log(`[4] ⚠️ 无 P6 打点 ⇒ 本轮未走到模型下发路径（或桥未重启加载新探针）`);
}
console.log("");
