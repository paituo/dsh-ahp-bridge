#!/usr/bin/env node
/**
 * P3 注入工具：向 VS Code 本地 agent host bundle 注入「provider 壳 + 桥改道」的 DSH provider。
 *
 * 用法（三个动作）：
 *   node apply-p3.mjs status   # 查看当前注入态 + 自动探测结果 + 备份
 *   node apply-p3.mjs probe    # 只做探测（不写任何文件），打印全部探测结果
 *   node apply-p3.mjs apply    # 注入（自动备份 → 写入 → node --check 校验）
 *   node apply-p3.mjs revert   # 回滚（移除 P3 片段，或从备份恢复）
 *
 * 安全设计：
 *   1) 注入前**必须**先备份原文件（带时间戳 + 仓库独立备份）
 *   2) 写入后立刻 `node --check` 语法校验；失败则自动回滚
 *   3) revert 优先「精确移除片段」，并校验移除后与备份是否一致（可选）
 *   4) ★ 抗更新：版本目录 / 锚点 / 壳类 / DI / providerService / fs 全部**自动探测**，
 *      探测不到就**明确报错并中止**（绝不带着 undefined 静默注入）。
 *
 * ★★ 为什么必须自动探测（2026-10-16 血案）：
 *   VS Code 每次更新都会换版本目录名（= commit 前 8 位）并**重写 bundle**：
 *     · 旧目录 `2a59476c9b`（1.141.x）被整个删除 → 同目录 `.bak_p3_*` 备份一并蒸发
 *     · 压缩变量名全部重排：`tt`→`Xe`、`m`→`h`、`D`→`q`、`gm`→`df`
 *   ⇒ 「硬编码路径 + 硬编码符号名」的注入**天然无法跨版本存活**。
 *   本脚本把这两类硬编码全部改为「按结构特征探测」。
 *
 * 前置：bundle 里需存在 provider 注册块 `X.registerProvider(Y.createInstance(Z)),`
 *       （X/Y/Z 均自动探测；官方三连：copilotcli / codex / claude）。
 * 依赖：`__SPAWN_NS__` 需替换为 bundle 内已存在的 spawn 命名空间（自动探测）。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

/* ────────────────────────── ① 版本目录自动定位 ────────────────────────── */

/** VS Code 安装根（可被 env 覆盖）。 */
const VSCODE_ROOT = process.env.BOWEI_VSCODE_ROOT || "D:/JavaSofewares/Microsoft VS Code";

/**
 * 自动定位 `<root>/<commit8>/resources/app/out/vs`。
 * 版本目录名 = commit 前 8 位（小写十六进制），每次更新都会变。
 * @returns {{out:string, versionDir:string, version:string, commit:string, productJson:string}}
 */
function locateVSCode() {
  if (process.env.BOWEI_VSCODE_OUT) {
    const out = process.env.BOWEI_VSCODE_OUT;
    return { out, versionDir: path.dirname(path.dirname(path.dirname(path.dirname(out)))), version: "?", commit: "?" };
  }
  if (!fs.existsSync(VSCODE_ROOT)) throw new Error(`VS Code 根目录不存在: ${VSCODE_ROOT}`);
  const cands = fs.readdirSync(VSCODE_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^[0-9a-f]{8,}$/i.test(d.name))
    .map((d) => {
      const dir = path.join(VSCODE_ROOT, d.name);
      const out = path.join(dir, "resources/app/out/vs");
      const pj = path.join(dir, "resources/app/product.json");
      let mtime = 0;
      try { mtime = fs.statSync(path.join(dir, "resources/app/out/vs/platform/agentHost/node/agentHostMain.js")).mtimeMs; } catch (_) {}
      return { dir, out, pj, mtime, name: d.name };
    })
    .filter((c) => fs.existsSync(path.join(c.out, "platform/agentHost/node/agentHostMain.js")))
    .sort((a, b) => b.mtime - a.mtime);

  if (!cands.length) throw new Error(`在 ${VSCODE_ROOT} 下未找到任何含 agentHostMain.js 的版本目录`);
  const hit = cands[0];
  let version = "?", commit = "?";
  try {
    const pj = JSON.parse(fs.readFileSync(hit.pj, "utf8"));
    version = pj.version ?? "?"; commit = pj.commit ?? "?";
  } catch (_) {}
  if (cands.length > 1) {
    console.log(`⚠ 发现 ${cands.length} 个候选版本目录，取最新（mtime）:`);
    cands.forEach((c, i) => console.log(`   ${i === 0 ? "★" : " "} ${c.name}  mtime=${new Date(c.mtime).toISOString()}`));
  }
  return { out: hit.out, versionDir: hit.name, version, commit, productJson: hit.pj };
}

const LOC = (() => {
  try { return locateVSCode(); }
  catch (e) { console.error(`版本目录定位失败: ${e.message}`); process.exit(2); }
})();

const VSCODE_OUT = LOC.out;
const TARGET = path.join(VSCODE_OUT, "platform/agentHost/node/agentHostMain.js");

const MARK_B = "/*BOWEI-DSH-P3-BEGIN*/";
const MARK_E = "/*BOWEI-DSH-P3-END*/";

const BRIDGE = process.env.DSH_BRIDGE
  || "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30/temp/dsh-ahp-bridge/bridge/src/bridge.mjs";
const DSH_BIN = process.env.DSH_BIN
  || "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";
const NODE_EXE = process.env.BRIDGE_NODE
  || "C:/Users/liuyue/.workbuddy/binaries/node/versions/22.22.2-2/node.exe";
const CWD = process.env.DSH_CWD || "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30";

/** 仓库内独立备份目录（不随 VS Code 更新蒸发）。 */
const REPO_BAK_DIR = process.env.BOWEI_P3_BAK_DIR
  || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "bak");

const read = (p) => fs.readFileSync(p, "utf8");

/* ────────────────────────── ② 结构特征探测 ────────────────────────── */

/** 探测 spawn 命名空间（形如 `X.spawn(` 的静态调用），取最高频。 */
function detectSpawnNamespace(src) {
  const re = /([A-Za-z_$][\w$]*)\.spawn\(/g;
  const hits = new Map();
  let m;
  while ((m = re.exec(src))) hits.set(m[1], (hits.get(m[1]) || 0) + 1);
  return [...hits.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ ns: k, count: n }));
}

/**
 * ★ 探测 provider 注册块（抗压缩改名）。
 *
 * 目标形态（1.141.x）：`D.registerProvider(m.createInstance(tt)),`
 * 目标形态（1.142.0）：`q.registerProvider(h.createInstance(Xe)),`
 *
 * 判据不看变量名，看**结构**：`<A>.registerProvider(<B>.createInstance(<C>)),`
 * 且 A/B 在**同一 bootstrap 作用域**内（由 `providerService` / `instantiationService`
 * 的赋值语句印证）。官方三连注册共用一个 (A,B)，C 依次为 copilotcli/codex/claude。
 *
 * @returns {{anchor:string, svc:string, di:string, shells:string[], all:string[]}|null}
 */
function detectRegistrationBlock(src) {
  // ★ 兼容两种形态（后者是已注入后的改写形态，便于 status/probe 在已注入文件上也能正确解析）：
  //   X.registerProvider(Y.createInstance(Z))
  //   X.registerProvider(_p3base=Y.createInstance(Z))
  const re = /([A-Za-z_$][\w$]*)\.registerProvider\((?:[A-Za-z_$][\w$]*=)?([A-Za-z_$][\w$]*)\.createInstance\(([A-Za-z_$][\w$]*)\)\)/g;

  // ★ 必须屏蔽「注入片段区间」内的伪匹配 —— 片段自身注释里含示例文本
  //   （如 "D.registerProvider(m.createInstance(tt))"），否则会被当成真注册点。
  const snipStart = src.indexOf(MARK_B);
  const snipEnd = src.indexOf(MARK_E);
  const inSnippet = (idx) => snipStart >= 0 && snipEnd > snipStart && idx >= snipStart && idx <= snipEnd + MARK_E.length;

  const rows = [];
  let m;
  while ((m = re.exec(src))) {
    if (inSnippet(m.index)) continue;
    rows.push({ at: m.index, svc: m[1], di: m[2], cls: m[3], text: m[0] });
  }
  if (!rows.length) return null;

  // 按 (svc, di) 分组，取出现次数最多的组合
  const g = new Map();
  for (const r of rows) {
    const k = `${r.svc}|${r.di}`;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  }
  const best = [...g.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  const picks = best[1].sort((a, b) => a.at - b.at);
  return {
    // ★ anchor 归一化为【未改写形态】（apply 要在 revert 后的原文里查找它）
    anchor: `${best[0].split("|")[0]}.registerProvider(${best[0].split("|")[1]}.createInstance(${picks[0].cls})),`,
    svc: best[0].split("|")[0],
    di: best[0].split("|")[1],
    shells: picks.map((p) => p.cls),
    all: rows.map((r) => r.text),
  };
}

/**
 * ★ 探测 bootstrap 里 stateManager / logService / fs 的实际变量名。
 *
 * 判据（1.142.0 逐字，**不依赖名字**）：
 *   `let p,g,h,f,y,S,_,C,b,R=...`
 *   `g=p.agentService,h=p.instantiationService`
 *   `H=h.invokeFunction(z=>({...providerService:z.get(wn),stateManager:z.get(me)...}))`
 *   `...,y=H.stateManager,...`        ← ★ stateManager 真身：局部变量 = <inv 结果>.stateManager
 *   `u=new eO(l,[c]);u.info("Agent Host process started successfully")` ← logService
 *
 * ★ 血案：不能全库 grep `X.stateManager` —— 类字段 `_stateManager` 出现 1067 次，
 *   会把类字段误判为 bootstrap 局部。必须**限制在 bootstrap 段内**（以
 *   "Agent Host process started successfully" 为锚向后取窗），再用 `X=Y.stateManager` 形态匹配。
 */
function detectBootstrapSymbols(src) {
  const out = { stateManager: null, logService: null, fsNs: null, evidence: [] };

  // ★ 限定 bootstrap 段：以启动日志锚点为中心取窗（**前后都要**）——
  //   logService 的接收者在锚点**之前**（`X.info("Agent Host process started successfully")`），
  //   stateManager 的赋值在锚点**之后**（`y=H.stateManager`）。
  //   ★ 只向后取窗会漏掉 logService（实测踩过一次）。
  const anchorIdx = src.indexOf("Agent Host process started successfully");
  const boot = anchorIdx >= 0 ? src.slice(Math.max(0, anchorIdx - 2500), anchorIdx + 4000) : src;

  // stateManager：`Y = <某表达式>.stateManager`（bootstrap 局部赋值形态）
  const smAssign = boot.match(/([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\.stateManager\b/);
  if (smAssign) { out.stateManager = smAssign[1]; out.evidence.push(`bootstrap 内 \`${smAssign[1]}=…stateManager\``); }

  // logService：形如 `X.info("Agent Host process started successfully")` 的接收者
  const logHit = boot.match(/([A-Za-z_$][\w$]*)\.info\("Agent Host process started successfully"\)/);
  if (logHit) { out.logService = logHit[1]; out.evidence.push(`\`${logHit[1]}.info("Agent Host process started successfully")\``); }

  // fs：`import * as X from "fs"` 之一，取全库 fs 方法命中最多者（越频繁越可能是主 fs 命名空间）
  const fsAliases = new Set();
  const reImport = /import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*["']fs["']/g;
  let m; while ((m = reImport.exec(src))) fsAliases.add(m[1]);
  let best = null;
  for (const a of fsAliases) {
    const c = (src.match(new RegExp(`\\b${a}\\.(appendFileSync|mkdirSync|writeFileSync|existsSync|readFileSync|statSync)\\b`, "g")) || []).length;
    if (!best || c > best.c) best = { ns: a, c };
  }
  if (best && best.c > 0) { out.fsNs = best.ns; out.evidence.push(`fs 别名 \`${best.ns}\`（fs 方法命中 ${best.c} 次）`); }

  return out;
}

/** 一次性探测全部注入所需符号。 */
function probeAll(src) {
  const reg = detectRegistrationBlock(src);
  const boot = detectBootstrapSymbols(src);
  const spawns = detectSpawnNamespace(src);
  return { reg, boot, spawns };
}

/** 打印探测结果；缺失项以 ✗ 标出。 */
function printProbe(p, { quiet = false } = {}) {
  const { reg, boot, spawns } = p;
  if (!quiet) console.log(`target : ${TARGET}`);
  console.log(`版本   : ${LOC.version} (commit ${LOC.commit})`);
  console.log(`目录   : ${LOC.versionDir}`);
  if (reg) {
    console.log(`注册块 : svc=${reg.svc} di=${reg.di} shells=[${reg.shells.join(", ")}] (共 ${reg.all.length} 个注册点)`);
    // ★ 区分「锚点原形态」与「已被改写为 _p3base=…」（改写后应显示重写形态，否则误判未注入）
    const rewritten = /\.registerProvider\([A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\.createInstance\([A-Za-z_$][\w$]*\)\)/.test(reg.anchor);
    console.log(`锚点   : ${reg.anchor}${rewritten ? "  ★已改写(_p3base=返回值)" : ""}`);
  } else {
    console.log(`注册块 : ✗ 未探测到（期望 <A>.registerProvider(<B>.createInstance(<C>)),）`);
  }
  console.log(`stateManager : ${boot.stateManager ? boot.stateManager + " ✓" : "✗ 未探测到"}`);
  console.log(`logService   : ${boot.logService ? boot.logService + " ✓" : "✗ 未探测到"}`);
  console.log(`fs 命名空间  : ${boot.fsNs ? boot.fsNs + " ✓" : "✗ 未探测到"}`);
  console.log(`spawn ns     : ${spawns.slice(0, 5).map((x) => `${x.ns}(${x.count})`).join(", ") || "✗ 未探测到"}`);
  return { reg, boot, spawns };
}

/* ────────────────────────── ③ 片段构造 ────────────────────────── */

/**
 * 从 src/inject-snippet.mjs 读取**唯一权威**片段并替换占位符。
 * ★ 不再内联复制（曾因两份不同步导致注入的是旧逻辑：用 chatId 当 threadId、漏 initialize 握手）。
 */
async function buildSnippet(probe) {
  const { P3_TT_SHELL_REROUTE_SNIPPET, readMessageText, resolveSessionWorkingDir, uriLikeToFsPath, expandChatUriVariants } = await import("../src/inject-snippet.mjs");
  let s = P3_TT_SHELL_REROUTE_SNIPPET;

  const { reg, boot, spawns } = probe;
  const spawnNs = process.env.BOWEI_SPAWN_NS || (spawns[0] && spawns[0].ns);

  // ★ 抗更新占位符：由探测结果填充（旧版是硬编码 tt/m/D/gm）
  s = s.replace(/__SPAWN_NS__/g, spawnNs)
       .replace(/__SHELL_CLS__/g, reg.shells[0])
       .replace(/__DI__/g, reg.di)
       .replace(/__PROVIDER_SVC__/g, reg.svc)
       .replace(/__FS_NS__/g, boot.fsNs)
       .replace(/__STATE_MGR__/g, boot.stateManager)
       .replace(/__LOG_SVC__/g, boot.logService)
       .replace(/__BRIDGE__/g, BRIDGE.replace(/\\/g, "/"))
       .replace(/__DSH_BIN__/g, DSH_BIN.replace(/\\/g, "/"))
       .replace(/__NODE__/g, NODE_EXE.replace(/\\/g, "/"))
       .replace(/__CWD__/g, CWD.replace(/\\/g, "/"))
       // ★ 单一真源：把导出的函数**源码**注入片段（避免多处不同步）。
       .replace(/__READ_TEXT__/g, readMessageText.toString())
       .replace(/__RESOLVE_WD__/g, resolveSessionWorkingDir.toString())
       .replace(/__URI_TO_PATH__/g, uriLikeToFsPath.toString())
       .replace(/__EXPAND_CHAT_URI__/g, expandChatUriVariants.toString());

  // 残留占位符 = 探测漏项 → 明确报错，绝不静默注入
  const leftover = s.match(/__[A-Z_]+__/g);
  if (leftover) throw new Error(`片段仍有未替换占位符: ${[...new Set(leftover)].join(", ")}（对应探测项为空）`);

  s = s.trim();
  s = s.replace(/^\s*\/\* >>> BOWEI-DSH-P3-BEGIN >>> \*\/\s*/, MARK_B + "\n");
  s = s.replace(/\s*\/\* <<< BOWEI-DSH-P3-END <<< \s*\*\/\s*$/, "\n" + MARK_E);
  return s;
}

/* ────────────────────────── ④ 动作 ────────────────────────── */

function status() {
  const s = read(TARGET);
  const injected = s.includes(MARK_B);
  console.log(`target : ${TARGET}`);
  console.log(`size   : ${s.length}`);
  console.log(`P3注入 : ${injected ? "是" : "否"}`);
  const p = probeAll(s);
  printProbe(p, { quiet: true });
  const dirBaks = fs.readdirSync(path.dirname(TARGET)).filter((f) => f.startsWith("agentHostMain.js.bak_"));
  console.log(`同目录备份 : ${dirBaks.length} 个${dirBaks.length ? " " + dirBaks.slice(-3).join(", ") : ""}`);
  try {
    const repoBaks = fs.readdirSync(REPO_BAK_DIR).filter((f) => f.includes("agentHostMain"));
    console.log(`仓库备份   : ${repoBaks.length} 个 → ${repoBaks.join(", ") || "(空)"}`);
  } catch (_) { console.log(`仓库备份   : ✗ 目录不存在 ${REPO_BAK_DIR}`); }
  return injected;
}

function probeCmd() {
  const s = read(TARGET);
  const p = probeAll(s);
  printProbe(p);
  console.log("");
  if (p.reg) {
    console.log("→ 全部注册点：");
    p.reg.all.forEach((t, i) => console.log(`   [${i}] ${t}`));
  }
  return !!(p.reg && p.boot.fsNs && p.boot.stateManager && p.boot.logService && p.spawns.length);
}

function backup(src) {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  // ① 同目录（沿用旧机制）
  const b = `${TARGET}.bak_p3_${ts}`;
  fs.writeFileSync(b, src);
  console.log(`已备份(同目录) → ${b}`);
  // ② ★ 仓库独立备份（防 VS Code 更新删目录）
  try {
    fs.mkdirSync(REPO_BAK_DIR, { recursive: true });
    const rb = path.join(REPO_BAK_DIR, `agentHostMain.js.${LOC.version}.${LOC.versionDir}.before-p3-${ts}`);
    fs.writeFileSync(rb, src);
    const h = execFileSync("sha256sum", [rb], { encoding: "utf8" }).split(/\s+/)[0];
    console.log(`已备份(仓库)   → ${rb}`);
    console.log(`                SHA256 ${h}`);
  } catch (e) {
    console.log(`⚠ 仓库备份失败（不影响注入）: ${e.message}`);
  }
  return b;
}

function check() {
  try {
    execFileSync(process.execPath, ["--check", TARGET], { stdio: "pipe" });
    console.log("node --check: OK");
    return true;
  } catch (e) {
    console.log("node --check: FAIL");
    console.log(String(e.stderr || e.stdout || e).slice(0, 2000));
    return false;
  }
}

async function apply() {
  let s = read(TARGET);
  if (s.includes(MARK_B)) { console.log("已注入，先 revert 再 apply。"); return; }

  const probe = probeAll(s);
  printProbe(probe);

  // ★ 硬门槛：探测缺项 → 中止（不注入）
  const missing = [];
  if (!probe.reg) missing.push("注册块(锚点)");
  if (!probe.boot.stateManager) missing.push("stateManager");
  if (!probe.boot.logService) missing.push("logService");
  if (!probe.boot.fsNs) missing.push("fs 命名空间");
  if (!probe.spawns.length) missing.push("spawn 命名空间");
  if (missing.length) {
    console.log(`\n✗ 探测缺项，已中止注入：${missing.join(", ")}`);
    console.log(`  可手动指定：BOWEI_SPAWN_NS / BOWEI_VSCODE_OUT，或检查片段占位符与 bundle 结构。`);
    process.exit(3);
  }

  let snippet;
  try { snippet = await buildSnippet(probe); }
  catch (e) { console.log(`\n✗ 片段构造失败，已中止：${e.message}`); process.exit(3); }

  const anchor = probe.reg.anchor;
  if (!s.includes(anchor)) { console.log(`✗ 锚点在源中不存在: ${anchor}`); process.exit(3); }

  // ★ 关键修复（2026-10-16）：不让片段再次 createInstance 壳类。
  // 1.142 的 copilotcli 壳类（探针 probe.shell）构造器内部会 new vE(...) → 向 fileService
  //    registerProvider("copilot-builtin")，而该 scheme 在上游这一行已被注册一次；
  //    片段若再 createInstance 同一个壳类 → "already registered" 抛异常 → 整段被 catch 吞。
  // 因此把上游的实例化改写为 `(...)=h.createInstance(X)`，用一个中间变量接住同一个实例，片段直接复用。
  // 变量名用 _p3base（单行内 let 声明也可，此处用赋值给外层未声明变量会污染；改用箭头参数传递更稳）。
  // 实现：把 anchor 拆成 "前缀" + "createInstance(壳)" + ")," ，在 createInstance 前插入 `_p3base=`，
  //       并把片段改造成接收该实例：((_p3base) => { ... })(...) 形式由 buildSnippet 负责。
  const m = anchor.match(/^([\s\S]*?)([A-Za-z_$][\w$]*\.createInstance\()([A-Za-z_$][\w$]*)(\)[\s\S]*)$/);
  if (!m) { console.log(`✗ 锚点形态无法安全改写（需 …DI.createInstance(X)…）: ${anchor}`); process.exit(3); }
  const callHead = m[1];                  // 例： "q.registerProvider("
  const diCall = m[2];                    // 例： "h.createInstance("
  const shellCls = m[3];                  // 例： "Xe"
  const anchorTail = m[4];                // 例： ")),"

  // ★ 严格模式安全：必须**显式声明** _p3base（ESM 下 `_p3base=X` 会 ReferenceError）。
  //   在锚点之前、同一 bootstrap 函数作用域里，找到 `let B=H.agentSdkDownloader,q=H.providerService;`
  //   这句，在末尾补 `,_p3base`（用 let 声明，与 B/q 同作用域）。
  const declRe = /let\s+B=H\.agentSdkDownloader\s*,\s*q=H\.providerService\s*;/;
  if (!declRe.test(s)) { console.log(`✗ 未找到 B/q 声明句，无法安全声明 _p3base`); process.exit(3); }
  s = s.replace(declRe, (t) => t.replace(/;$/, ", _p3base;"));   // let B=…,q=…, _p3base;
  console.log(`已在同作用域声明 _p3base（严格模式安全）`);

  // 锚点改写：把整个 createInstance(...) 调用的【返回值】接进 _p3base，片段直接复用（零二次实例化）
  //   q.registerProvider( h.createInstance(Xe) )   →   q.registerProvider( _p3base = h.createInstance(Xe) )
  const newAnchor = `${callHead}_p3base=${diCall}${shellCls}${anchorTail}`;
  console.log(`锚点改写：…registerProvider(${diCall}${shellCls})) → _p3base=返回值（复用上游唯一实例，避免二次注册 copilot-builtin）`);

  backup(s);
  s = s.replace(anchor, newAnchor + snippet + ",");
  fs.writeFileSync(TARGET, s);
  console.log("已写入注入片段。");
  if (!check()) {
    console.log("语法校验失败 → 从备份恢复...");
    revertFromLatestBak();
    process.exit(1);
  }
  console.log("\n注入完成。请重启 VS Code 使生效。");
}

function revertFromLatestBak() {
  const dir = path.dirname(TARGET);
  const baks = fs.readdirSync(dir).filter((f) => f.startsWith("agentHostMain.js.bak_")).sort();
  if (!baks.length) { console.log("无备份可用"); return; }
  const last = path.join(dir, baks[baks.length - 1]);
  fs.copyFileSync(last, TARGET);
  console.log(`已从备份恢复: ${baks[baks.length - 1]}`);
}

function revert() {
  let s = read(TARGET);
  if (!s.includes(MARK_B)) { console.log("当前未注入 P3。"); return; }
  const i = s.indexOf(MARK_B);
  const j = s.indexOf(MARK_E);
  let end = j + MARK_E.length;
  if (s[end] === ",") end += 1;
  s = s.slice(0, i) + s.slice(end);
  // ★ 同时还原锚点改写与声明（否则下次探测的锚点会漂移到别的 provider）
  s = s.replace(/_p3base=([A-Za-z_$][\w$]*\.createInstance\([A-Za-z_$][\w$]*\))/g, "$1");
  s = s.replace(/(let\s+B=H\.agentSdkDownloader\s*,\s*q=H\.providerService)\s*,\s*_p3base\s*;/g, "$1;");
  fs.writeFileSync(TARGET, s);
  console.log("已移除 P3 片段（并还原锚点改写 / _p3base 声明）。");
  check();
}

const cmd = process.argv[2] || "status";
if (cmd === "status") status();
else if (cmd === "probe") probeCmd();
else if (cmd === "apply") await apply();
else if (cmd === "revert") revert();
else console.log("用法: node apply-p3.mjs [status|probe|apply|revert]");
