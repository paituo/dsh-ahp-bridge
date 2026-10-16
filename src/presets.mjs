/**
 * DSH agent preset 发现模块（路线 B 核心）
 *
 * 背景（2026-10-11 实证，见 docs/路线B-实现与验证-*.md）：
 *   DSH 的 agent preset **不通过 ACP 暴露**（dsh-acp 依赖里零 preset 引用；
 *   acp profile 的 cordis.patch.yml 也不 insert agent-preset-registry）。
 *   故桥必须**自己去发现** preset，再映射成 VS Code 的 agent picker 项。
 *
 * ★ 关键更正（推翻早前「桥直读 ~/.dsh/.agent-presets/」的假设）：
 *   DSH 自带技能 `dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md` 原文：
 *     "Before declaration rows, a user preset was a directory `$DSH_HOME/.agent-presets/<id>/`
 *      holding preset.yml ... and agent.cordis.yml ... **Nothing reads that directory any more.**"
 *   ⇒ `~/.dsh/.agent-presets/` 是**遗留死目录**，现代 preset 一律是 **bundle 声明行**：
 *     ① **shipped**：`@deepseek-ai/dsh-web-app` bundle 的 `presets/<id>.patch.yml`
 *        （id = standard / ptc / minimal / cordis）
 *     ② **用户自装**：用 `plugin_manager` install_bundle 装的 bundle，其 cordis.patch.yml
 *        里 insert 形如 `- id: preset-<id> / name: '@deepseek-ai/dsh-agent-preset'` 的行
 *
 * 本模块从**两处**发现 preset（都只读）：
 *   A. dsh 安装目录下所有 presets 子目录里的 patch.yml（shipped presets）
 *   B. 各 profile 的 package.json `dsh.profile.bundles` 所列 bundle 的 cordis.patch.yml
 *      （含 `preset-*` 行的，即用户自装/自带 bundle 声明的 preset）
 *   外加 C. 兼容读取遗留目录 ~/.dsh/.agent-presets/<id>/preset.yml（仅标记 legacy，不挂载）。
 */

import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const DSH_HOME_DEFAULT = path.join(os.homedir(), ".dsh");

/**
 * DSH shipped preset 的官方显示名/描述（取自 dsh-client-ui-agent-preset 的
 * 中文 locale 字典；shipped 的 patch.yml 里**不含** name/description，故在此补齐）。
 */
const SHIPPED_DISPLAY = {
  standard: {
    name: "标准模式",
    description: "处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。",
  },
  ptc: {
    name: "PTC 模式",
    description: "包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。",
  },
  minimal: {
    name: "极简模式",
    description: "Agent 仅使用终端工具完成任务，适合测试和对比其基础表现。",
  },
  cordis: {
    name: "创作者模式",
    description: "用对话定制 DSH：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。",
  },
};

/** 从 YAML 文本里粗提取 preset 声明行（不引 yaml 依赖；preset 声明结构极规整）。
 *
 * 目标形态（见 dsh-agent-preset.conf 的 Config schema）：
 *   - id: preset-standard
 *     name: '@deepseek-ai/dsh-agent-preset'
 *     config:
 *       id: standard
 *       name: ...
 *       description: ...
 *       order: 1
 *       plugins: [...]
 *
 * 我们只需 id / name / description / order（用于 picker 展示）；
 * plugins 交给 DSH 自己（我们不重放编排）。
 */
export function parsePresetDeclarations(yamlText, sourceLabel) {
  const out = [];
  if (!yamlText || typeof yamlText !== "string") return out;
  const lines = yamlText.split(/\r?\n/);

  // 逐行状态机：找到 `name: '@deepseek-ai/dsh-agent-preset'` 附近的 config.id
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 该行声明了 agent-preset 插件
    if (!/name:\s*['"]?@deepseek-ai\/dsh-agent-preset['"]?\s*$/.test(line.trim())) continue;

    // 往上找最近的 `- id: preset-xxx`（loader row id）
    let rowId = null;
    for (let j = i - 1; j >= Math.max(0, i - 12); j--) {
      const m = lines[j].match(/^\s*-\s*id:\s*['"]?(preset-[A-Za-z0-9-]+)['"]?\s*$/);
      if (m) { rowId = m[1]; break; }
      // 撞到另一个顶层 row 就停（避免跨行误配）
      if (/^\s*-\s*id:\s*/.test(lines[j]) && j !== i - 1) { /* 继续找，但限制 12 行 */ }
    }

    // 往下找 config 块里的 id / name / description / order
    let cfgId = null, cfgName = null, cfgDesc = null, cfgOrder = null;
    let inConfig = false;
    for (let k = i + 1; k < Math.min(lines.length, i + 40); k++) {
      const l = lines[k];
      const t = l.trim();
      if (/^config:\s*$/.test(t)) { inConfig = true; continue; }
      // 退出条件：出现新的顶层 `- id:` 行（下一个 row）或 `- insert:` 等
      if (/^-\s/.test(l) && !/^\s{6,}/.test(l)) break;
      if (!inConfig) continue;
      let m;
      if ((m = t.match(/^id:\s*['"]?([A-Za-z0-9-]+)['"]?\s*$/)) && cfgId === null) cfgId = m[1];
      else if ((m = t.match(/^name:\s*['"]?(.+?)['"]?\s*$/)) && cfgName === null) cfgName = m[1];
      else if ((m = t.match(/^description:\s*['"]?(.+?)['"]?\s*$/)) && cfgDesc === null) cfgDesc = m[1];
      else if ((m = t.match(/^order:\s*(-?\d+)\s*$/)) && cfgOrder === null) cfgOrder = Number(m[1]);
      else if (/^plugins:\s*$/.test(t)) break;   // 到 plugins 就够，后面不需要
    }

    const id = cfgId || (rowId ? rowId.replace(/^preset-/, "") : null);
    if (!id) continue;
    out.push({
      id,
      rowId: rowId || `preset-${id}`,
      name: cfgName || id,
      description: cfgDesc || "",
      order: cfgOrder ?? 100,
      source: sourceLabel,
    });
  }
  return out;
}

/** 在 dsh 安装目录下找所有 shipped presets 目录里的 *.patch.yml */
async function discoverShippedPresets(dshInstallDir) {
  const found = [];
  if (!dshInstallDir) return found;
  let entries = [];
  try {
    entries = await fsp.readdir(dshInstallDir, { withFileTypes: true });
  } catch { return found; }
  // 布局：<dsh>/node_modules/@deepseek-ai/<pkg>/presets/*.patch.yml
  const scan = async (base) => {
    let subs = [];
    try { subs = await fsp.readdir(base, { withFileTypes: true }); } catch { return; }
    for (const s of subs) {
      if (!s.isDirectory()) continue;
      const presetsDir = path.join(base, s.name, "presets");
      let files = [];
      try { files = await fsp.readdir(presetsDir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith(".patch.yml")) continue;
        const full = path.join(presetsDir, f);
        try {
          const txt = await fsp.readFile(full, "utf8");
          const decls = parsePresetDeclarations(txt, `shipped:${s.name}/${f}`);
          for (const d of decls) { d.path = full; found.push(d); }
        } catch { /* skip unreadable */ }
      }
    }
  };
  // @deepseek-ai/*（nested node_modules）
  await scan(path.join(dshInstallDir, "node_modules", "@deepseek-ai"));
  await scan(dshInstallDir);
  return found;
}

/** 从某 profile 的 bundles 清单里找声明了 preset 的 bundle 的 cordis.patch.yml */
async function discoverBundlePresets(profileDir, dshHome) {
  const found = [];
  const pkgPath = path.join(profileDir, "package.json");
  let pkg;
  try { pkg = JSON.parse(await fsp.readFile(pkgPath, "utf8")); } catch { return found; }
  const bundles = pkg?.dsh?.profile?.bundles ?? [];
  // 候选解析根：profile 自己的 node_modules，其次 <dshHome>/node_modules
  const roots = [path.join(profileDir, "node_modules"), path.join(dshHome, "node_modules")];
  for (const b of bundles) {
    for (const root of roots) {
      const base = path.join(root, ...b.split("/"));
      // ① bundle 自己的 cordis.patch.yml（可能含 preset-* insert 行）
      // ② bundle 的 presets/ 子目录
      const cands = [path.join(base, "cordis.patch.yml")];
      try {
        for (const f of await fsp.readdir(path.join(base, "presets"))) {
          if (f.endsWith(".patch.yml")) cands.push(path.join(base, "presets", f));
        }
      } catch { /* no presets dir */ }
      for (const c of cands) {
        let txt;
        try { txt = await fsp.readFile(c, "utf8"); } catch { continue; }
        const decls = parsePresetDeclarations(txt, `bundle:${b}`);
        for (const d of decls) { d.path = c; found.push(d); }
      }
    }
  }
  return found;
}

/** 兼容遗留目录：~/.dsh/.agent-presets/<id>/{preset.yml}（仅标记，不挂载） */
async function discoverLegacyPresets(dshHome) {
  const found = [];
  const dir = path.join(dshHome, ".agent-presets");
  let subs = [];
  try { subs = await fsp.readdir(dir, { withFileTypes: true }); } catch { return found; }
  for (const s of subs) {
    if (!s.isDirectory()) continue;
    const yml = path.join(dir, s.name, "preset.yml");
    let txt;
    try { txt = await fsp.readFile(yml, "utf8"); } catch { continue; }
    const getName = txt.match(/^name:\s*(.+?)\s*$/m);
    const getDesc = txt.match(/^description:\s*(.+?)\s*$/m);
    const getOrder = txt.match(/^order:\s*(-?\d+)\s*$/m);
    found.push({
      id: s.name,
      rowId: `preset-${s.name}`,
      name: getName ? getName[1].trim() : s.name,
      description: getDesc ? getDesc[1].trim() : "",
      order: getOrder ? Number(getOrder[1]) : 100,
      source: "legacy:.agent-presets",
      legacy: true,
      path: yml,
    });
  }
  return found;
}

/**
 * 汇总发现：返回去重后的 preset 列表（按 order, name 排序）。
 * @param {{dshHome?:string, dshInstallDir?:string, profileName?:string, profileDir?:string, includeLegacy?:boolean}} opts
 */
export async function discoverPresets(opts = {}) {
  const dshHome = opts.dshHome || DSH_HOME_DEFAULT;
  const profileName = opts.profileName || "acp";
  const profileDir = opts.profileDir || path.join(dshHome, "profiles", profileName);
  const dshInstallDir = opts.dshInstallDir || null;

  const [shipped, bundle, legacy] = await Promise.all([
    discoverShippedPresets(dshInstallDir),
    discoverBundlePresets(profileDir, dshHome),
    opts.includeLegacy ? discoverLegacyPresets(dshHome) : Promise.resolve([]),
  ]);

  // 去重：同 id 优先 bundle 声明（用户覆盖）> shipped；legacy 仅补充缺失项
  const byId = new Map();
  const put = (list, rank) => {
    for (const d of list) {
      const prev = byId.get(d.id);
      // rank 小者优先：bundle=0, shipped=1, legacy=2
      if (!prev || rank < prev._rank) byId.set(d.id, { ...d, _rank: rank });
    }
  };
  put(bundle, 0);
  put(shipped, 1);
  put(legacy, 2);

  const list = [...byId.values()].map(({ _rank, ...d }) => {
    // shipped preset 的 patch.yml 不含 name/description → 用官方 locale 字典补齐
    const disp = SHIPPED_DISPLAY[d.id];
    const isFallbackName = !d.name || d.name === d.id;
    return {
      ...d,
      name: isFallbackName && disp ? disp.name : d.name,
      description: (!d.description && disp) ? disp.description : d.description,
    };
  });
  list.sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  return {
    presets: list,
    counts: { shipped: shipped.length, bundle: bundle.length, legacy: legacy.length, total: list.length },
    sources: { dshHome, profileName, profileDir, dshInstallDir },
  };
}

export const _internal = { discoverShippedPresets, discoverBundlePresets, discoverLegacyPresets };
