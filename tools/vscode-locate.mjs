#!/usr/bin/env node
/**
 * VS Code 安装定位器（单一真源）。
 *
 * ★★ 为什么需要它（2026-10-16 血案）：
 *   VS Code 每次更新都会换版本目录名（= commit 前 8 位）并**重写 bundle**。
 *   全项目曾有 8 个文件硬编码 `2a59476c9b`，一次更新后**全部失效**。
 *   ⇒ 统一改用本模块，按结构自动定位，不再硬编码任何版本号。
 *
 * 用法：
 *   import { locateVSCode, agentHostMainPath, vscodeSkillsDir } from "./vscode-locate.mjs";
 *   const loc = locateVSCode();
 *   const target = agentHostMainPath(loc);
 *
 * 覆盖：环境变量 BOWEI_VSCODE_ROOT（安装根）/ BOWEI_VSCODE_OUT（直接指定 out/vs）
 */
import fs from "node:fs";
import path from "node:path";

export const VSCODE_ROOT = process.env.BOWEI_VSCODE_ROOT || "D:/JavaSofewares/Microsoft VS Code";

/**
 * 定位 `<root>/<commit8>/resources/app/out/vs`。
 * 多个候选目录时取「agentHostMain.js mtime 最新」的那个（= 当前生效版本）。
 * @returns {{out:string, versionDir:string, version:string, commit:string, root:string}}
 */
export function locateVSCode() {
  if (process.env.BOWEI_VSCODE_OUT) {
    const out = process.env.BOWEI_VSCODE_OUT;
    // 反推版本目录：.../<commit8>/resources/app/out/vs
    const versionDir = path.basename(path.dirname(path.dirname(path.dirname(path.dirname(out)))));
    const pj = path.join(path.dirname(path.dirname(path.dirname(out))), "product.json");
    let version = "?", commit = "?";
    try { const j = JSON.parse(fs.readFileSync(pj, "utf8")); version = j.version ?? "?"; commit = j.commit ?? "?"; } catch (_) {}
    return { out, versionDir, version, commit, root: VSCODE_ROOT };
  }

  if (!fs.existsSync(VSCODE_ROOT)) {
    throw new Error(`VS Code 根目录不存在: ${VSCODE_ROOT}（可用 BOWEI_VSCODE_ROOT 覆盖）`);
  }

  const cands = fs.readdirSync(VSCODE_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^[0-9a-f]{8,}$/i.test(d.name))
    .map((d) => {
      const dir = path.join(VSCODE_ROOT, d.name);
      const out = path.join(dir, "resources/app/out/vs");
      const main = path.join(out, "platform/agentHost/node/agentHostMain.js");
      let mtime = 0;
      try { mtime = fs.statSync(main).mtimeMs; } catch (_) {}
      return { dir, out, mtime, name: d.name, hasMain: fs.existsSync(main) };
    })
    .filter((c) => c.hasMain)
    .sort((a, b) => b.mtime - a.mtime);

  if (!cands.length) throw new Error(`在 ${VSCODE_ROOT} 下未找到含 agentHostMain.js 的版本目录`);

  const hit = cands[0];
  const pj = path.join(hit.dir, "resources/app/product.json");
  let version = "?", commit = "?";
  try {
    const j = JSON.parse(fs.readFileSync(pj, "utf8"));
    version = j.version ?? "?"; commit = j.commit ?? "?";
  } catch (_) {}

  return { out: hit.out, versionDir: hit.name, version, commit, root: VSCODE_ROOT, candidates: cands };
}

/** agentHostMain.js 绝对路径。 */
export function agentHostMainPath(loc = locateVSCode()) {
  return path.join(loc.out, "platform/agentHost/node/agentHostMain.js");
}

/** 内置 skills 目录（e2e-skills-list 用）。 */
export function vscodeSkillsDir(loc = locateVSCode()) {
  return path.join(loc.out, "sessions/skills");
}

/** 打印一行定位摘要（CLI 友好）。 */
export function describe(loc = locateVSCode()) {
  return `VS Code ${loc.version} (${loc.versionDir}) → ${loc.out}`;
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  try { console.log(describe()); }
  catch (e) { console.error(e.message); process.exit(2); }
}
