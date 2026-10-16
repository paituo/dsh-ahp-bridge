// ═══════════════════════════════════════════════════════════════════════════
// repro-runtime-boot.mjs —— 离线「运行时自证」复现器（DSH AHP P3 注入）
//
// 目的：不重启 VS Code，直接在 Node 里**加载当前 injected 的 agentHostMain.js**，
//       让它真实执行到注入片段，验证 registerProvider 是否 RETURNED OK。
//
// 为什么需要它：磁盘内容对 ≠ 运行时对（曾栽在这里）。
//   agentHostMain.js 是 VS Code out/ 下的**明文 ESM**（不在 asar 内），
//   它的依赖（vscode 的 out/ 模块、node_modules）大多可解析；少数平台模块
//   需要 mock。本脚本：
//     1) 设置 globalThis._VSCODE_FILE_ROOT（否则内部 toUri 抛 "Cannot determine URI for module id!"）
//     2) 注入 NLS mock（否则 NLS 缺失抛错）
//     3) 用 --import 一个 loader 把无法解析的模块替换为宽松 stub
//     4) 捕获 process.stderr + ironboot.log，判定 registerProvider 结局
//
// 用法:
//   node tools/repro-runtime-boot.mjs            # 自动定位当前生效 bundle
//   AHP_BUNDLE=/path/to/agentHostMain.js node tools/repro-runtime-boot.mjs
// ═══════════════════════════════════════════════════════════════════════════
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentHostMainPath } from "./vscode-locate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(__dirname, "..");
const BUNDLE = process.env.AHP_BUNDLE || agentHostMainPath();
const APP_ROOT = path.resolve(path.dirname(BUNDLE), "../../../../../../"); // .../resources/app

const IRONBOOT = path.resolve(BRIDGE, "../temp/ironboot.log");

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

// ── 0. 前置事实 ────────────────────────────────────────────────────────────
const src = fs.readFileSync(BUNDLE, "utf8");
const facts = {
  bundle: BUNDLE,
  size: src.length,
  markB: (src.match(/\/\*BOWEI-DSH-P3-BEGIN\*\//g) || []).length,
  markE: (src.match(/\/\*BOWEI-DSH-P3-END\*\//g) || []).length,
  anchorRewritten: /registerProvider\([A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\.createInstance\([A-Za-z_$][\w$]*\)\)/.test(src),
  reuseLine: /=\s*\(typeof _p3base\s*!==\s*"undefined"\s*&&\s*_p3base\)/.test(src),
  declP3: /let\s+[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\.agentSdkDownloader\s*,\s*[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\.providerService\s*,\s*_p3base\s*;/.test(src),
};
console.log("── 磁盘事实 ─────────────────────────────");
for (const [k, v] of Object.entries(facts)) console.log(`  ${k}: ${v}`);

if (facts.markB !== 1 || facts.markE !== 1) {
  console.log("\n✗ 注入标记缺失，无法复现（先 apply-p3 apply）");
  process.exit(2);
}

// ── 1. 清空 ironboot 便于判定 ─────────────────────────────────────────────
try { fs.writeFileSync(IRONBOOT, ""); } catch {}

// ── 2. 语法自检 ───────────────────────────────────────────────────────────
const chk = sh(process.execPath, ["--check", BUNDLE]);
console.log(`\n── node --check: ${chk.status === 0 ? "OK" : "FAIL"}\n${chk.stderr || ""}`);

// ── 3. 造一个 loader：把不可解析的 import 变成宽松 stub ───────────────────
const loaderPath = path.resolve(BRIDGE, "temp/_repro-stub-loader.mjs");
fs.mkdirSync(path.dirname(loaderPath), { recursive: true });
fs.writeFileSync(loaderPath, `
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

// 解包出来的真实 VS Code 依赖根（优先于 stub）
const REAL_ROOT = ${JSON.stringify(path.resolve(BRIDGE, "../temp/nm-asar"))};

// 宽松 stub：**任何**解析失败的裸包 → Proxy stub（保真度低，但保证执行能推进到注入片段）
const STUB = "data:text/javascript,export default new Proxy({},{get:(t,k)=>{if(k==='then')return undefined;if(k==='default')return t;if(k==='__esModule')return true;const f=()=>({});f.__stub=true;return f;}});export const __stub=true;";

function resolveReal(spec) {
  const pkgDir = path.join(REAL_ROOT, spec);
  const pj = path.join(pkgDir, "package.json");
  if (!fs.existsSync(pj)) return null;
  let meta; try { meta = JSON.parse(fs.readFileSync(pj, "utf8")); } catch { return null; }
  const exp = meta.exports && meta.exports["."];
  let entry = (exp && exp.import && (exp.import.default || exp.import)) || meta.module || meta.main || "index.js";
  if (typeof entry !== "string") entry = meta.main || "index.js";
  const abs = path.join(pkgDir, entry);
  return fs.existsSync(abs) ? pathToFileURL(abs).href : null;
}

export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); }
  catch (e) {
    if (spec.startsWith(".") || spec.startsWith("file:") || spec.startsWith("node:")) throw e;
    const real = resolveReal(spec);
    if (real) return { url: real, shortCircuit: true, format: "module" };
    return { url: STUB, shortCircuit: true, format: "module" };
  }
}
export async function load(url, ctx, next) {
  if (url.startsWith("data:text/javascript,")) {
    return { format: "module", source: decodeURIComponent(url.slice("data:text/javascript,".length)), shortCircuit: true };
  }
  return next(url, ctx);
}
`);

// ── 4. bootstrap：注册 hooks（同线程 register）+ 设环境 + mock NLS + import bundle ──
const bootPath = path.resolve(BRIDGE, "temp/_repro-boot.mjs");
fs.writeFileSync(bootPath, `
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "node:module";

// ① 必须用 register() 挂载 loader（--import 直接跑模块不会生效）
register(pathToFileURL(${JSON.stringify(loaderPath)}).href, pathToFileURL("./"));

const BUNDLE = ${JSON.stringify(BUNDLE)};
const APP_ROOT = ${JSON.stringify(APP_ROOT)};

// ① VS Code 内部 toUri 依赖它
globalThis._VSCODE_FILE_ROOT = APP_ROOT.replace(/\\\\/g, "/") + "/";

// ② NLS mock：缺 key 时返回占位而非抛错
globalThis.__REPRO_NLS__ = true;
const origError = console.error;
console.error = (...a) => { if (String(a[0]).includes("NLS")) return; origError(...a); };

// ③ AMD/require 兜底（部分模块用 global require）
if (typeof globalThis.require === "undefined") {
  globalThis.require = () => ({});
}

const mainUrl = pathToFileURL(BUNDLE).href;
try {
  await import(mainUrl);
  process.stderr.write("[repro] bundle import resolved (no top-level throw)\\n");
} catch (e) {
  process.stderr.write("[repro] bundle import THREW: " + (e && e.stack || e) + "\\n");
}
// 给内部异步注册一点时间
await new Promise(r => setTimeout(r, 2500));
process.stderr.write("[repro] done waiting\\n");
`);

console.log("── 运行复现（最多 30s）──────────────────");
const run = sh(process.execPath, [bootPath], {
  timeout: 30000,
  env: {
    ...process.env,
    VSCODE_DEV: "1",
    // 让裸包解析命中解包出来的真实 VS Code 依赖（比 stub 保真）
    NODE_PATH: [
      path.resolve(BRIDGE, "../temp/nm-asar"),
      path.resolve(BRIDGE, "../temp/nm-asar.unpacked"),
      process.env.NODE_PATH || "",
    ].filter(Boolean).join(path.delimiter),
  },
});

console.log("exit:", run.status, run.signal || "");
const out = (run.stdout || "") + (run.stderr || "");
const keep = out.split("\n").filter(l => /repro|dsh-ironboot|registerProvider|THREW|already registered|Error/.test(l)).slice(-40);
console.log(keep.join("\n"));

console.log("\n── ironboot.log ─────────────────────────");
let log = "";
try { log = fs.readFileSync(IRONBOOT, "utf8"); } catch {}
console.log(log.trim() || "(空)");

console.log("\n── 判定 ─────────────────────────────────");
const ok = /registerProvider RETURNED OK/.test(log) || /registerProvider RETURNED OK/.test(out);
const threw = /already registered|THREW/.test(out) || /THREW/.test(log);
console.log(ok && !threw ? "✅ 运行时 registerProvider RETURNED OK（无异常）"
                        : (threw ? "❌ 运行时抛异常" : "⚠️ 未见注册成功标记（可能被环境限制）"));
