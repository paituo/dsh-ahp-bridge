/**
 * DSH profile patch 的「读写 / 合并 / 热更新」工具（路线 C 的桥侧实现）。
 *
 * 背景（2026-10-11 实测）：
 *   1. VS Code 侧 BYOK（`chatLanguageModels.json`）与 DSH 侧 provider 清单**不一致**，
 *      且存在「同名不同后端」的静默错配（例：`deepseek-v4-flash` VS Code→内网 172.20.0.145，
 *      DSH→DeepSeek 官方）。
 *   2. VS Code 有 `rpc.provider.sync` 通道想让 host（DSH）接住 BYOK，**但桥未实现**（现在也不做，
 *      因为 ACP stdio 上没有该 RPC，且密钥在 VS Code 侧加密）。
 *   3. **已启用** ACP profile 的 HMR（`~/.dsh/profiles/acp/cordis.patch.yml` 中 `- id: hmr / disabled: false`）
 *      ⇒ 「改文件 → DSH 自动热加载 provider → 推送 config_option_update」成立（已端到端实测）。
 *
 * 因此桥侧实现路线 C：**把 VS Code BYOK 的 provider 桥接写进 DSH profile patch 文件**，
 * 由 HMR 自动热加载，使两侧模型清单一致（消歧义 + 补全缺失模型）。
 *
 * ★★★ 三条铁律（实测血案）：
 *   1) `providers` 是**整体替换**语义 —— 必须「先读全量 → 合并 → 整体写回」，绝不"只写新增项"。
 *   2) 必须**保留** `- id: hmr / disabled: false` 条目 —— 否则覆盖回 disabled，热更新失效。
 *   3) **绝不写入明文密钥** —— VS Code 的 key 在 SecretStorage（加密），桥拿不到；
 *      桥只写 `apiKeyEnv`（凭据引用名），用户需在 `~/.dsh/.credentials.yaml` 的 refs 段配一次。
 *
 * 写入策略：**幂等**（内容不变则完全不动文件 ⇒ 不触发无谓的 HMR 重载）+ **原子写**
 *   （tmp + rename，避免 HMR 读到半截文件）+ **备份**（首次写入前留副本）。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const MARK_BEGIN = "# ==== BOWEI-AHP-BYOK-BEGIN (auto-managed; do not edit by hand) ====";
const MARK_END = "# ==== BOWEI-AHP-BYOK-END ====";

/** 定位 profile patch 文件路径（与 discovery.resolveProfileDir 同源规则） */
export function resolveProfilePatchPath(profile = "acp", opts = {}) {
  const dshHome = opts.dshHome ?? process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
  return path.join(dshHome, "profiles", profile, "cordis.patch.yml");
}

/**
 * 极简 YAML 子集读取：解析顶层数组里的 `- id: X` 块，返回 id → {startLine, endLine, lines}。
 * 只认「顶层 `- ` 起始 + 缩进块」，足够定位 `llm-pi-ai` / `hmr` 条目。
 */
function scanTopLevelEntries(lines) {
  const entries = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^-\s/.test(l) && !/^\s/.test(l)) {           // 顶层条目起点
      if (cur) { cur.endLine = i - 1; entries.push(cur); }
      const m = /^-\s+id:\s*(\S+)/.exec(l);
      cur = { id: m ? m[1].replace(/^["']|["']$/g, "") : null, startLine: i, endLine: lines.length - 1, lines: [] };
    }
    if (cur) cur.lines.push(l);
  }
  if (cur) { cur.endLine = lines.length - 1; entries.push(cur); }
  // 去掉尾部紧邻的空行/注释（归属下一个条目前的空白）
  for (const e of entries) {
    while (e.lines.length > 1 && (e.lines[e.lines.length - 1].trim() === "")) e.lines.pop();
  }
  return entries;
}

/** 读 patch 文本 → 结构（内部统一按 LF 切分，避免 CRLF 环境的 `\r` 污染正则） */
export function parsePatch(text) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const entries = scanTopLevelEntries(lines);
  const byId = new Map();
  for (const e of entries) if (e.id) byId.set(e.id, e);
  return { lines, entries, byId };
}

/**
 * 从 `llm-pi-ai` 条目的 config.providers 段解析出「已存在的 provider 名」集合。
 * 极简缩进解析：providers: 之后比其更深一级的 `name:` 即 provider 名。
 */
export function extractProviderNames(patchText) {
  const { byId } = parsePatch(patchText);
  const entry = byId.get("llm-pi-ai");
  if (!entry) return [];
  const names = [];
  let inProviders = false, provIndent = -1;
  for (const l of entry.lines) {
    const mProviders = /^(\s*)providers:\s*$/.exec(l);
    if (mProviders) { inProviders = true; provIndent = mProviders[1].length; continue; }
    if (!inProviders) continue;
    const mKey = /^(\s+)([A-Za-z0-9._-]+):\s*$/.exec(l);
    if (mKey) {
      const ind = mKey[1].length;
      if (ind === provIndent + 2) names.push(mKey[2]);      // provider 键（比 providers 深一级）
      continue;
    }
    if (l.trim() && /^\s*/.exec(l)[0].length <= provIndent) break;  // 回到同级 → 结束
  }
  return names;
}

/** 判断 patch 是否已启用 hmr（`- id: hmr` 且其后 disabled: false） */
export function isHmrEnabled(patchText) {
  const { byId } = parsePatch(patchText);
  const e = byId.get("hmr");
  if (!e) return false;
  return /^\s*disabled:\s*false\s*$/m.test(e.lines.join("\n"));
}

/**
 * 生成「BYOK provider 段」的 YAML 文本（缩进对齐到 providers 之下）。
 *
 * @param {Array<{key, displayName, apiKeyEnv, api, baseURL, models:Array<{id,name}>}>} providers
 * @param {string} indent providers 项的基础缩进（如 "      "）
 */
export function renderProviderBlock(providers, indent) {
  const out = [];
  for (const p of providers) {
    out.push(`${indent}${p.key}:`);
    if (p.displayName) out.push(`${indent}  displayName: ${yamlScalar(p.displayName)}`);
    out.push(`${indent}  apiKeyEnv: ${p.apiKeyEnv}`);
    out.push(`${indent}  api: ${p.api ?? "openai-completions"}`);
    out.push(`${indent}  baseURL: ${p.baseURL}`);
    out.push(`${indent}  models:`);
    for (const m of p.models) {
      out.push(`${indent}    - id: ${yamlScalar(m.id)}`);
      out.push(`${indent}      name: ${yamlScalar(m.name ?? m.id)}`);
    }
  }
  return out.join("\n");
}

function yamlScalar(s) {
  const v = String(s ?? "");
  return /^[A-Za-z0-9._/-]+$/.test(v) ? v : JSON.stringify(v);
}

/**
 * 把一行行 provider 块切成 [{key, lines, managed}]。
 * 输入：providers 段内的行（不含 `providers:` 自身），provIndent = providers 的缩进。
 */
function splitProviderChunks(segLines, provIndent, managed) {
  const chunks = [];
  let cur = null;
  const isKeyLine = (l) => {
    const m = /^(\s+)([A-Za-z0-9._-]+):\s*$/.exec(l);
    return m && m[1].length === provIndent + 2 ? m[2] : null;
  };
  for (const l of segLines) {
    const k = isKeyLine(l);
    if (k !== null) {
      if (cur) chunks.push(cur);
      cur = { key: k, lines: [l], managed: managed.has(k) };
      continue;
    }
    if (cur) cur.lines.push(l);
    else if (l.trim() !== "") cur = { key: null, lines: [l], managed: false };  // 异常游离行，原样保留
  }
  if (cur) chunks.push(cur);
  // 去掉每个 chunk 尾部的空行（空白由渲染阶段统一控制）
  for (const c of chunks) while (c.lines.length > 1 && c.lines[c.lines.length - 1].trim() === "") c.lines.pop();
  return chunks;
}

/**
 * 把 BYOK provider 合并进 patch 文本。
 *
 * 语义：**保留非桥管理的现有 provider 原样** + 用新版覆盖桥管理的 provider。
 * （`providers` 在 DSH 侧是整体替换语义，所以"保留"是必须的，不是可选优化。）
 *
 * @param {string} patchText 现有 patch 全文
 * @param {Array} providers  形如 renderProviderBlock 的输入
 * @param {{managedKeys?:string[], dropKeys?:string[]}} [opts]
 *        managedKeys = 由桥管理、本次将重写的 key（旧版丢弃、写新版）
 *        dropKeys    = 桥要主动移除的 key
 * @returns {{text:string, changed:boolean, added:string[], removed:string[]}}
 */
export function mergeProvidersIntoPatch(patchText, providers, opts = {}) {
  const NL = patchText.includes("\r\n") ? "\r\n" : "\n";
  const { byId, lines } = parsePatch(patchText);
  const entry = byId.get("llm-pi-ai");

  const newKeys = providers.map((p) => p.key);
  const managed = new Set([...(opts.managedKeys ?? []), ...newKeys]);
  const drop = new Set(opts.dropKeys ?? []);

  // —— 情形 A：没有 llm-pi-ai 条目 → 新建一个（放在文件末尾，hmr 之类的直接覆盖条目之前）
  if (!entry) {
    const block = [
      `- id: llm-pi-ai`,
      `  name: "@deepseek-ai/dsh-llm-pi-ai"`,
      `  config:`,
      `    providers:`,
      renderProviderBlock(providers, "      "),
    ];
    const hmr = byId.get("hmr");
    if (hmr) {
      const before = lines.slice(0, hmr.startLine);
      const after = lines.slice(hmr.startLine);
      const text = [...before, ...block, "", ...after].join(NL);
      return { text, changed: text !== patchText, added: newKeys, removed: [] };
    }
    const text = patchText.replace(/\n*$/, NL) + NL + block.join(NL) + NL;
    return { text, changed: text !== patchText, added: newKeys, removed: [] };
  }

  // —— 情形 B：有 llm-pi-ai，定位 providers 段
  const entryLines = [...entry.lines];
  let provIdx = -1, provIndent = -1;
  for (let i = 0; i < entryLines.length; i++) {
    const m = /^(\s*)providers:\s*$/.exec(entryLines[i]);
    if (m) { provIdx = i; provIndent = m[1].length; break; }
  }

  let headLines, chunks, tailLines;
  if (provIdx < 0) {
    // B2：有 llm-pi-ai 但无 providers: 段 → 在 config: 下插入，现有内容全部保留为头部
    const cfgIdx = entryLines.findIndex((l) => /^\s*config:\s*$/.test(l));
    const cfgIndent = cfgIdx >= 0 ? /^(\s*)/.exec(entryLines[cfgIdx])[1].length : 2;
    const pad = " ".repeat(cfgIndent + 2);
    const insertAt = cfgIdx >= 0 ? cfgIdx + 1 : entryLines.length;
    entryLines.splice(insertAt, 0, `${pad}providers:`);
    provIdx = insertAt;
    provIndent = cfgIndent + 2;
  }

  // providers 段范围 [provIdx+1, segEnd)
  let segEnd = entryLines.length;
  for (let i = provIdx + 1; i < entryLines.length; i++) {
    const l = entryLines[i];
    if (l.trim() === "") continue;
    if (/^(\s*)/.exec(l)[1].length <= provIndent) { segEnd = i; break; }
  }
  headLines = entryLines.slice(0, provIdx + 1);
  const segLines = entryLines.slice(provIdx + 1, segEnd);
  tailLines = entryLines.slice(segEnd);
  while (tailLines.length && tailLines[0].trim() === "") tailLines.shift();

  const allChunks = splitProviderChunks(segLines, provIndent, managed);
  const existingKeys = allChunks.map((c) => c.key).filter(Boolean);
  const kept = allChunks.filter((c) => c.key === null || (!managed.has(c.key) && !drop.has(c.key)));
  const removed = existingKeys.filter((k) => drop.has(k) || ((opts.managedKeys ?? []).includes(k) && !newKeys.includes(k)));

  const pad = " ".repeat(provIndent + 2);
  const rebuilt = [...headLines, ...kept.flatMap((c) => c.lines)];
  if (newKeys.length) rebuilt.push(renderProviderBlock(providers, pad));
  if (tailLines.length) { rebuilt.push(""); rebuilt.push(...tailLines); }

  const before = lines.slice(0, entry.startLine);
  const after = lines.slice(entry.endLine + 1);
  const text = [...before, ...rebuilt, ...after].join(NL);

  const added = newKeys.filter((k) => !existingKeys.includes(k));
  return { text, changed: text !== patchText, added, removed };
}

/**
 * 把 patch 文本写入文件：原子 + 幂等 + 备份。
 * @returns {{written:boolean, backup?:string, reason?:string}}
 */
export async function writePatchAtomic(patchPath, text, opts = {}) {
  const cur = await fsp.readFile(patchPath, "utf8").catch(() => null);
  if (cur === text) return { written: false, reason: "identical" };

  if (cur !== null && opts.backup !== false) {
    const bak = `${patchPath}.bowel-ahp-bak-${stamp()}`;
    await fsp.writeFile(bak, cur, "utf8");
    opts.onBackup?.(bak);
  }
  const tmp = `${patchPath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, text, "utf8");
  await fsp.rename(tmp, patchPath);            // 原子替换（同目录）
  return { written: true };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------- VS Code BYOK → DSH provider

/**
 * 把 VS Code BYOK 配置（`chatLanguageModels.json` 已解析对象）转成 DSH provider 描述。
 *
 * 映射规则：
 *   - 每个 BYOK 「vendor 组」（`name`/`vendor`/`apiKey`）→ 一个 DSH provider；
 *   - provider key = 归一化组名（小写、非字母数字→`-`），确保与 DSH 现有命名风格一致；
 *   - `baseURL` 取该组下 model 的 `url`（同组各 model 应一致，取首个非空）；
 *   - `apiKeyEnv` = `BOWEI_AHP_BYOK_<KEY>_API_KEY`（**引用名，不是密钥**）。
 *
 * ⚠️ 密钥无法自动桥接：VS Code 存的是 `${input:chat.lm.secret.xxx}`（SecretStorage 加密），
 *    桥拿不到明文 ⇒ 用户需在 `~/.dsh/.credentials.yaml` 的 refs 段为上述 apiKeyEnv 配一次。
 *
 * @param {Array} byok chatLanguageModels.json 解析结果
 * @param {{prefix?:string, skipKeys?:string[]}} [opts]
 */
export function byokToDshProviders(byok, opts = {}) {
  const prefix = opts.prefix ?? "BOWEI_AHP_BYOK";
  const skip = new Set(opts.skipKeys ?? []);
  const out = [];
  for (const grp of byok ?? []) {
    const key = normalizeKey(grp?.name ?? grp?.vendor);
    if (!key || skip.has(key)) continue;
    const models = [];
    let baseURL = null;
    for (const m of grp?.models ?? []) {
      if (!m?.id) continue;
      if (!baseURL && m.url) baseURL = m.url;
      models.push({ id: m.id, name: m.name ?? m.id });
    }
    if (!models.length || !baseURL) continue;
    out.push({
      key,
      displayName: grp.name ?? key,
      apiKeyEnv: `${prefix}_${key.replace(/-/g, "_").toUpperCase()}_API_KEY`,
      api: "openai-completions",
      baseURL,
      models,
      // 溯源信息（不写入 YAML，供调用方判断/日志）
      _source: { vendor: grp.vendor, apiKeyRef: grp.apiKey ? "(secret, not bridged)" : null },
    });
  }
  return out;
}

/** 归一化 provider key：小写、非 [a-z0-9] → `-`、折叠、去首尾 `-` */
export function normalizeKey(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------- 高层入口

/**
 * 一次性完成：读 patch → 合并 BYOK providers → 幂等原子写入。
 *
 * @param {object} cfg
 * @param {Array}  cfg.byok             VS Code BYOK 数组（chatLanguageModels.json 解析结果）
 * @param {string} cfg.profile          DSH profile（默认 acp）
 * @param {string} [cfg.dshHome]
 * @param {string[]} [cfg.skipKeys]     要跳过的 provider key（如两侧已同名的 DSH 原生 provider）
 * @param {string[]} [cfg.managedKeys]  上次桥写入的 key（本次用于清理/改名）
 * @param {boolean} [cfg.dryRun]        true = 只算不写
 * @returns {Promise<{patchPath, changed, added, removed, written, providers, hmrEnabled, backup?}>}
 */
export async function syncByokToDshPatch(cfg) {
  const patchPath = resolveProfilePatchPath(cfg.profile ?? "acp", { dshHome: cfg.dshHome });
  const text = await fsp.readFile(patchPath, "utf8").catch(() => null);
  if (text === null) throw new Error(`profile patch 不存在: ${patchPath}`);

  const providers = byokToDshProviders(cfg.byok, { skipKeys: cfg.skipKeys });
  const hmrEnabled = isHmrEnabled(text);
  const merged = mergeProvidersIntoPatch(text, providers, { managedKeys: cfg.managedKeys });

  const result = {
    patchPath,
    hmrEnabled,
    providers: providers.map((p) => ({ key: p.key, baseURL: p.baseURL, models: p.models.map((m) => m.id), apiKeyEnv: p.apiKeyEnv })),
    changed: merged.changed,
    added: merged.added,
    removed: merged.removed,
    written: false,
  };
  if (!merged.changed || cfg.dryRun) return result;

  const w = await writePatchAtomic(patchPath, merged.text, { onBackup: (b) => { result.backup = b; } });
  result.written = w.written;
  return result;
}

/**
 * 生成可粘贴的「凭据补全」提示（因为密钥无法自动桥接）。
 * @returns {string}
 */
export function credentialHint(providerList) {
  const lines = ["# 在 ~/.dsh/.credentials.yaml 的 refs 段补上（把 <你的key> 换成真实值）：", "refs:"];
  for (const p of providerList) lines.push(`  ${p.apiKeyEnv}: <你的key>`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- 凭据补全（可选，用户显式提供明文时）

/**
 * 定位凭据文件 `$DSH_HOME/.credentials.yaml`。
 * 依据 dsh-credentials-local：`filename = config.path ?? join(resolveDshHome(config.dshHome), ".credentials.yaml")`。
 */
export function resolveCredentialsPath(opts = {}) {
  const dshHome = opts.dshHome ?? process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
  return path.join(dshHome, ".credentials.yaml");
}

/**
 * 设置/新增一个 refs 条目（**明文写入，调用方须确认用户已显式提供密钥**）。
 *
 * 血案关联：DSH 的凭据解析优先级 = env > refs(文件) > dotenv；
 * 缺凭据时报 `no credential for provider route ... its profile resolves <REF>`。
 * 本函数只做 refs 段的最小增量写入（保留其它内容与 records 段），**不做 YAML 重排**。
 *
 * @param {string} ref   POSIX 标识符（dsh-credentials-local 约束 refs 键）
 * @param {string} value 非空字符串
 * @param {{dshHome?:string, dryRun?:boolean}} [opts]
 * @returns {Promise<{path:string, changed:boolean, written:boolean, existed:boolean}>}
 */
export async function setCredentialRef(ref, value, opts = {}) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new Error(`ref 非法（需 POSIX 标识符）：${ref}`);
  if (typeof value !== "string" || value.length === 0) throw new Error(`值不能为空（删除请用 unset）`);

  const p = resolveCredentialsPath(opts);
  const text = await fsp.readFile(p, "utf8").catch(() => null);
  if (text === null) throw new Error(`凭据文件不存在: ${p}`);

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const refsIdx = lines.findIndex((l) => /^refs:\s*$/.test(l));
  if (refsIdx < 0) throw new Error(`凭据文件缺少 refs: 段: ${p}`);

  // refs 段范围（到下一个顶层键为止）
  let end = lines.length;
  for (let i = refsIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (/^\S/.test(lines[i])) { end = i; break; }
  }
  const re = new RegExp(`^\\s+${ref}:\\s`);
  let changed = false;
  const hitIdx = lines.findIndex((l, i) => i > refsIdx && i < end && re.test(l));
  if (hitIdx >= 0) {
    const want = `  ${ref}: ${value}`;
    if (lines[hitIdx] !== want) { lines[hitIdx] = want; changed = true; }
  } else {
    lines.splice(end, 0, `  ${ref}: ${value}`);
    changed = true;
  }
  const out = lines.join("\n");
  if (!changed) return { path: p, changed: false, written: false, existed: hitIdx >= 0 };
  if (opts.dryRun) return { path: p, changed: true, written: false, existed: hitIdx >= 0 };

  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, out, "utf8");
  await fsp.rename(tmp, p);
  return { path: p, changed: true, written: true, existed: hitIdx >= 0 };
}

/** 列出 refs 段的键名（**不返回值**，用于诊断"哪些凭据已配"） */
export async function listCredentialRefs(opts = {}) {
  const p = resolveCredentialsPath(opts);
  const text = await fsp.readFile(p, "utf8").catch(() => null);
  if (text === null) return { path: p, exists: false, refs: [] };
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const refsIdx = lines.findIndex((l) => /^refs:\s*$/.test(l));
  const refs = [];
  if (refsIdx >= 0) {
    for (let i = refsIdx + 1; i < lines.length; i++) {
      if (lines[i].trim() === "") continue;
      if (/^\S/.test(lines[i])) break;
      const m = /^\s+([A-Za-z_][A-Za-z0-9_]*):/.exec(lines[i]);
      if (m) refs.push(m[1]);
    }
  }
  return { path: p, exists: true, refs };
}

/**
 * 检查一批 provider 的 apiKeyEnv 是否都已配（用于写入后给出「还缺哪些」的明确提示）。
 * @returns {Promise<{missing:string[], configured:string[]}>}
 */
export async function checkCredentials(providerList, opts = {}) {
  const { refs } = await listCredentialRefs(opts);
  const set = new Set(refs);
  const missing = [], configured = [];
  for (const p of providerList) (set.has(p.apiKeyEnv) ? configured : missing).push(p.apiKeyEnv);
  return { missing, configured };
}

// ---------------------------------------------------------------- 权限三档 → profile patch
//
// ★★★ 背景（2026-10-15，见 src/permission-mode.mjs 顶部完整论证）：
//   DSH 的三档权限（read-only / workspace-write / danger-full-access）**没有 ACP 写通道**
//   —— DSH acp 只注册 9 个 onRequest（穷举无沙箱入口），`session/set_config_option`
//   对 preset 抛 `AcpPresetLockedError`（"the agent preset is fixed for a session"）。
//   唯一可行落点 = 部署层 profile patch（`~/.dsh/profiles/<profile>/cordis.patch.yml`），
//   它用 `!!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'` 定档，
//   且 acp profile **已启用 HMR**（`- id: hmr / disabled: false`）⇒ 改文件即热加载。

const PERM_BEGIN = "# ==== BOWEI-AHP-PERMISSION-BEGIN (auto-managed; do not edit by hand) ====";
const PERM_END = "# ==== BOWEI-AHP-PERMISSION-END ====";
/** 被本模块接管的三个 id（覆盖 base bundle 同名行） */
const PERM_MANAGED_IDS = ["sandbox-policy", "approval", "permission"];

/**
 * 从 patch 文本里解析出「当前生效的 DSH 权限档」。
 *
 * 判定顺序（与 base bundle 的配置语义一致）：
 *   ① `DSH_PERMISSION_MODE` 环境变量（运行时最高优先）
 *   ② 本模块写入的托管块里 pin 的档位
 *   ③ 任一被托管行里 literal 出现的三档名
 *   ④ 都找不到 → null（未知，调用方按 workspace-write 处理）
 *
 * @param {string} patchText
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null} 三档之一或 null
 */
export function resolvePermissionModeFromPatch(patchText, env = process.env) {
  const envMode = env?.DSH_PERMISSION_MODE;
  if (["read-only", "workspace-write", "danger-full-access"].includes(envMode)) return envMode;

  const { lines } = parsePatch(patchText);
  const text = lines.join("\n");

  // ② 托管块里 pin 的默认档：形如  mode: !!js process.env.DSH_PERMISSION_MODE ?? 'X'
  const pin = /DSH_PERMISSION_MODE\s*\?\?\s*'([a-z-]+)'/g;
  let m, last = null;
  while ((m = pin.exec(text)) !== null) {
    if (["read-only", "workspace-write", "danger-full-access"].includes(m[1])) last = m[1];
  }
  if (last) return last;

  // ③ 兜底：任何 literal 三档名（含 presets 表本身，取出现过的最后一项无意义，故只在有 sandbox-policy 时取）
  return null;
}

/** 移除已存在的托管权限块（幂等；同时移除被接管的三个 id 单独出现的旧行） */
function stripPermissionBlock(patchText) {
  const NL = patchText.includes("\r\n") ? "\r\n" : "\n";
  const lines = patchText.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let skipping = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === PERM_BEGIN) { skipping = true; continue; }
    if (l.trim() === PERM_END) { skipping = false; continue; }
    if (skipping) continue;
    out.push(l);
  }
  return { lines: out, NL };
}

/**
 * 移除**未被托管块包裹**但 id 属于被接管集合的顶层条目（防手写残留导致重复 id）。
 * @returns {{lines:string[], removed:string[]}}
 */
function stripBareManagedEntries(lines) {
  const { byId } = parsePatch(lines.join("\n"));
  const toDrop = [];
  for (const id of PERM_MANAGED_IDS) {
    const e = byId.get(id);
    if (e) toDrop.push(e);
  }
  if (!toDrop.length) return { lines, removed: [] };
  // 从后往前删，避免索引错位
  toDrop.sort((a, b) => b.startLine - a.startLine);
  const out = [...lines];
  const removed = [];
  for (const e of toDrop) {
    // 连带删掉该条目上方紧邻的注释行（形如 "# ★ ... 权限 ..."）
    let start = e.startLine;
    while (start - 1 >= 0 && /^\s*#/.test(out[start - 1])) start--;
    removed.push(e.id);
    out.splice(start, e.endLine - start + 1);
  }
  return { lines: out, removed };
}

/**
 * 把某个 DSH 权限档写进 profile patch（幂等 + 原子 + 备份）。
 *
 * ★ 行为：
 *   · 先摘掉旧的托管块与残留的同 id 条目 ⇒ 再在**文件末尾**追加新块
 *     （放末尾 = 最后写赢，能覆盖任何更早的层，与 base bundle 的注释语义一致）。
 *   · `dshMode === null` ⇒ 只做"移除托管块"（回退到 base bundle 行为），不追加。
 *
 * @param {string} patchText 现有 patch 文本
 * @param {string|null} dshMode 三档之一；null = 回退
 * @returns {{ text:string, changed:boolean, removed:string[], applied:string|null }}
 */
export function mergePermissionModeIntoPatch(patchText, dshMode) {
  const stripped = stripPermissionBlock(patchText);
  let lines = stripped.lines;
  const NL = stripped.NL;

  const bare = stripBareManagedEntries(lines);
  lines = bare.lines;

  // 去尾部多余空行
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();

  let applied = null;
  if (dshMode) {
    // 动态 import 避免循环依赖（permission-mode.mjs 不依赖本模块，但保持单向清晰）
    applied = dshMode;
    // 延迟取渲染函数：profile-patch.mjs 是底层工具，permission-mode.mjs 是纯数据/渲染
    // 这里直接内联等价渲染，避免 import 循环（node ESM 下静态循环会 TDZ）
    lines = [...lines, "", ...renderPermissionBlockInline(dshMode)];
  }

  const text = lines.join(NL).replace(/\n{3,}/g, "\n\n") + NL;
  return { text, changed: text !== patchText, removed: [...bare.removed, ...PERM_MANAGED_IDS], applied };
}

/**
 * 内联渲染权限覆盖块（与 permission-mode.mjs 的 renderPermissionOverrideBlock 等价，
 * 此处内联是为了避免 ESM 静态循环依赖）。
 */
function renderPermissionBlockInline(dshMode) {
  const knobs = {
    "read-only":          { sandbox: "read-only",          approval: "ask"   },
    "workspace-write":    { sandbox: "workspace-write",    approval: "ask"   },
    "danger-full-access": { sandbox: "danger-full-access", approval: "never" },
  }[dshMode] ?? { sandbox: "workspace-write", approval: "ask" };
  return [
    PERM_BEGIN,
    `# 桥按 VS Code 权限档写入 DSH 三档（当前：${dshMode}）。`,
    `# 三行联动覆盖 base bundle：sandbox-policy 定档 / approval 派生 / permission 表。`,
    `# 回退：删掉本块（含 BEGIN/END 两行）即恢复 base bundle 默认。`,
    `- id: sandbox-policy`,
    `  name: "@deepseek-ai/dsh-sandbox-policy"`,
    `  config:`,
    `    mode: !!js process.env.DSH_PERMISSION_MODE ?? '${knobs.sandbox}'`,
    `    workspaceRoot: !!js process.cwd()`,
    `- id: approval`,
    `  name: "@deepseek-ai/dsh-user-approval"`,
    `  config:`,
    `    policy: !!js "(process.env.DSH_PERMISSION_MODE ?? '${knobs.sandbox}') === 'danger-full-access' ? 'never' : '${knobs.approval}'"`,
    `- id: permission`,
    `  name: "@deepseek-ai/dsh-permission-presets"`,
    `  config:`,
    `    presets:`,
    `      read-only:`,
    `        sandbox: read-only`,
    `        approval: ask`,
    `      workspace-write:`,
    `        sandbox: workspace-write`,
    `        approval: ask`,
    `      danger-full-access:`,
    `        sandbox: danger-full-access`,
    `        approval: never`,
    PERM_END,
  ];
}

/**
 * 把 DSH 权限档落到 acp profile patch 文件（原子写 + 备份）。
 * @returns {Promise<{written:boolean, applied:string|null, backup?:string, reason?:string, patchPath:string}>}
 */
export async function applyPermissionModeToProfile(dshMode, opts = {}) {
  const profile = opts.profile ?? "acp";
  const patchPath = resolveProfilePatchPath(profile, opts);
  const cur = await fsp.readFile(patchPath, "utf8").catch(() => null);
  if (cur === null) return { written: false, applied: null, reason: "patch-not-found", patchPath };

  const { text, changed, applied } = mergePermissionModeIntoPatch(cur, dshMode);
  if (!changed) return { written: false, applied, reason: "identical", patchPath };

  const res = await writePatchAtomic(patchPath, text, { backup: true, onBackup: opts.onBackup });
  return { written: res.written, applied, backup: res.backup, reason: res.reason, patchPath };
}

export const __internal = { scanTopLevelEntries, renderProviderBlock, yamlScalar, normalizeKey, stripBareManagedEntries, renderPermissionBlockInline };
