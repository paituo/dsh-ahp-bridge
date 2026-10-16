/**
 * 同源发现器 —— 桥自行实现 DSH ACP 缺失的两处「数据类」能力：
 *   1) `skills/list`            —— 扫 DSH 真实技能目录（与 VS Code 同源的那批）
 *   2) `mcpServerStatus/list`   —— 读 DSH profile 里 dsh-mcp-client 的插件条目
 *
 * ★ 依据（本机实测源码，非臆测）：
 *   - 技能根目录 = @deepseek-ai/dsh-skill-filesystem/lib/index.js:roots()
 *       项目级: <projectRoot>/.dsh/skills        source=project-dsh
 *               <projectRoot>/.agents/skills     source=project-agents
 *       用户级: <DSH_HOME|~/.dsh>/skills         source=user-dsh
 *               <DSH_AGENTS_HOME|~/.agents>/skills source=user-agents
 *       技能形态: 目录包 <name>/SKILL.md，或扁平 <name>.md
 *       front-matter 字段: name / description（见 codex-cli-calling/SKILL.md）
 *   - MCP 配置 = profile 的 cordis.patch.yml 里 `dsh-mcp-client` 插件条目
 *       { serverName, transport: "stdio"|"streamable-http", command/args/env/cwd | url/headers }
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------- 小工具

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

/** 从 cwd 向上找项目根（.git 或 package.json 所在） */
async function findProjectRoot(start) {
  let cur = path.resolve(start);
  for (let i = 0; i < 40; i++) {
    if (await exists(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return path.resolve(start);
}

/**
 * 极简 front-matter 解析：取顶层 `key: value`，够 name/description 用。
 *
 * ★ 2026-10-11 血案修复：真实技能的 description **大量使用折叠标量**，例如
 *   ```yaml
 *   description: >
 *     Use this skill for software development tasks that should follow the RPD workflow:
 *     requirements, architecture planning, ...
 *   ```
 *   旧实现逐行 `key: value` 处理 ⇒ 把 `>` 当字面值 ⇒ description 变成字符串 `">"`（长度 1）。
 *   实测受影响：`rpd`、`ahp-skill-probe` 等真实技能的描述**全部丢失**，
 *   VS Code 技能面板会显示为空/错误描述 —— 属实质能力损失。
 *
 * 现支持四种标量写法（与 YAML 语义对齐到够用为止）：
 *   ① 单行：      `description: 一句话`
 *   ② 折叠标量：  `description: >`  或 `>-`   → 后续更深缩进行 join(" ")
 *   ③ 字面标量：  `description: |`  或 `|-`   → 后续更深缩进行 join("\n")
 *   ④ 引号标量：  `description: "..."` / `'...'`（含单行内含冒号的情况）
 * 另跳过嵌套块（如 `metadata:` 下的子键），避免把子键误当顶层键。
 */
function parseFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const lines = m[1].split(/\r?\n/);
  const out = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    i++;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const top = /^([A-Za-z_][\w.-]*):\s*(.*)$/.exec(line);
    if (!top) continue;                       // 缩进行（嵌套块内容）直接忽略
    const k = top[1];
    const raw = top[2].trim();

    // ② 折叠标量（>，>-, >+）：后续更深缩进行，中文/英文以空格连接
    // ③ 字面标量（|，|-, |+）：后续更深缩进行，以换行连接
    if (/^[>|][+-]?$/.test(raw)) {
      const fold = raw.startsWith(">");
      const baseIndent = line.length - line.trimStart().length;
      const parts = [];
      while (i < lines.length) {
        const l2 = lines[i];
        if (!l2.trim()) { i++; if (parts.length) parts.push(""); continue; }
        const ind = l2.length - l2.trimStart().length;
        if (ind <= baseIndent) break;         // 回到同级/上级 ⇒ 块结束
        parts.push(l2.trim());
        i++;
      }
      // 去尾部空段
      while (parts.length && parts[parts.length - 1] === "") parts.pop();
      const joined = fold
        ? parts.filter((p) => p !== "").join(" ")
        : parts.join("\n");
      if (k && joined) out[k] = joined;
      continue;
    }

    // ④ 引号标量（可能单行内含冒号，此处已由上方正则的贪心匹配兜住）
    let v = raw;
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
        (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
      v = v.slice(1, -1);
    }
    if (k && v) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- 技能发现

/** 导出供回归测试使用的 front-matter 解析器（生产路径经 readSkill 调用） */
export const parseFrontMatterForTest = parseFrontMatter;

/** DSH 侧真实技能根目录（顺序即优先级；后出现的同名覆盖前者） */
export async function resolveSkillRoots(cwd, opts = {}) {
  const dshHome = opts.dshHome ?? process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
  const agentsHome = opts.agentsHome ?? process.env.DSH_AGENTS_HOME ?? path.join(os.homedir(), ".agents");
  const roots = [];
  if (cwd) {
    const projectRoot = await findProjectRoot(cwd);
    roots.push({ path: path.join(projectRoot, ".dsh", "skills"), source: "project-dsh", scope: "project", projectRoot });
    roots.push({ path: path.join(projectRoot, ".agents", "skills"), source: "project-agents", scope: "project", projectRoot });
  }
  roots.push({ path: path.join(dshHome, "skills"), source: "user-dsh", scope: "user" });
  roots.push({ path: path.join(agentsHome, "skills"), source: "user-agents", scope: "user" });
  return roots;
}

/**
 * 扫描单个技能根目录，返回技能条目。
 * 形态：目录包 <name>/SKILL.md（含一层可选的分类子目录）或扁平 <name>.md。
 */
async function scanSkillRoot(root) {
  const found = [];
  if (!(await exists(root.path))) return found;
  let entries;
  try { entries = await fsp.readdir(root.path, { withFileTypes: true }); } catch { return found; }

  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(root.path, e.name);
    if (e.isDirectory()) {
      const skillMd = path.join(full, "SKILL.md");
      if (await exists(skillMd)) {
        found.push(await readSkill(skillMd, e.name, root));
      } else {
        // 分类子目录：<root>/<category>/<skill>/SKILL.md
        let subs = [];
        try { subs = await fsp.readdir(full, { withFileTypes: true }); } catch { continue; }
        for (const s of subs) {
          if (!s.isDirectory() || s.name.startsWith(".")) continue;
          const md = path.join(full, s.name, "SKILL.md");
          if (await exists(md)) found.push(await readSkill(md, s.name, root));
        }
      }
    } else if (e.isFile() && e.name.endsWith(".md") && e.name !== "SKILL.md") {
      found.push(await readSkill(full, e.name.replace(/\.md$/, ""), root));
    }
  }
  return found;
}

async function readSkill(mdPath, fallbackName, root) {
  let head = "";
  try {
    const fd = await fsp.open(mdPath, "r");
    // ★ 上限 16KB：实测最长技能的 front-matter 在第 17 行内结束（4096 也够），
    //   但多行折叠标量描述可能较长，放宽到 16KB 更稳；仍保留截断（不全量读大文件）。
    const CAP = 16 * 1024;
    const buf = Buffer.alloc(CAP);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    await fd.close();
    head = buf.subarray(0, bytesRead).toString("utf8");
  } catch { /* ignore */ }
  const fm = parseFrontMatter(head);
  // ★ description 截断到 1024 字符：与 VS Code 内置技能的 r9n(desc,1024) 上限对齐，
  //   避免超长描述撑爆 skills/list 载荷（VS Code 面板亦按此长度渲染）。
  const desc = (fm.description || "").slice(0, 1024);
  return {
    name: fm.name || fallbackName,
    description: desc,
    scope: root.scope,
    source: root.source,
    path: mdPath,
  };
}

/**
 * 一次扫描所有根 → 按 cwd 归组的 VS Code `skills/list` 结构。
 * VS Code 消费 `n.data[].skills[]`，每项形如 { name, description, scope, uri, ... }。
 *
 * @param {string[]} cwds
 * @param {object} [opts]
 * @returns {Promise<{data: Array<{cwd:string, skills:Array}>}>}
 */
export async function buildSkillsList(cwds, opts = {}) {
  const list = (cwds && cwds.length) ? cwds : [process.cwd()];
  const data = [];
  for (const cwd of list) {
    const roots = await resolveSkillRoots(cwd, opts);
    const seen = new Map(); // name → entry（后面的根覆盖前面的，贴合 DSH rank 语义）
    for (const root of roots) {
      for (const s of await scanSkillRoot(root)) seen.set(s.name, s);
    }
    data.push({
      cwd,
      // ★★★ 契约修正（2026-10-16）：权威 schema `SkillsListEntry.required = ["cwd","errors","skills"]`
      //   （codex-protocol-schema/SkillsListResponse.json）—— 此前漏 `errors`。
      errors: [],
      skills: [...seen.values()].map((s) => ({
        name: s.name,
        // ★★★ 契约修正（2026-10-16，**本回合根因**）：
        //   权威 schema `SkillMetadata.required = ["description","enabled","name","path","scope"]`。
        //   此前只给 `uri`，**未给 `path`** ⇒ VS Code `codexSkillsToContainers` → `skillToCustomization()`
        //   调 `URI.file(skill.path)`，而 `URI.file` 在 Windows 首行执行 `path.replace(/\\/g,'/')`
        //   ⇒ `undefined.replace(...)` ⇒ `Cannot read properties of undefined (reading 'replace')`
        //   ⇒ `getChatCustomizations failed` ⇒ **新建/发送消息全链路静默失败**（turn/start 永不发出）。
        //   修：`path` 必须是**绝对路径字符串**（AbsolutePathBuf），`uri` 保留仅作向后兼容。
        path: s.path ? String(s.path) : undefined,
        uri: s.path ? toFileUri(s.path) : undefined,
        description: s.description ?? "",
        scope: s.scope ?? "user",
        enabled: s.enabled !== false,
        source: s.source,
        disableModelInvocation: false,
        disableUserInvocation: false,
      })),
    });
  }
  return { data };
}

// ---------------------------------------------------------------- MCP 发现

/** 定位 profile 目录（优先 $DSH_HOME/profiles/<name>，退回 ~/.dsh/profiles/<name>） */
export function resolveProfileDir(profile = "acp", opts = {}) {
  const dshHome = opts.dshHome ?? process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
  return path.join(dshHome, "profiles", profile);
}

/**
 * 从 profile 的 cordis.patch.yml / 各 bundle 里解析 dsh-mcp-client 条目。
 * 这里做**极简 YAML 子集解析**：只认 `- serverName:` 起的块，取标量键。
 * 真正权威的解释器是 DSH 自己（!!js 表达式等由它求值），桥只做"如实上报"。
 *
 * @returns {Promise<{servers:Array<{name,transport,command?,args?,url?,source}>}>}
 */
export async function discoverMcpServers(profile = "acp", opts = {}) {
  const dir = resolveProfileDir(profile, opts);
  const servers = [];
  const candidates = [
    path.join(dir, "cordis.patch.yml"),
    // ★ 不回退读 `cordis.yml`：它是 DSH 启动时把 base/acp-app/用户 patch **合并后的产物**，
    //   读它会把同一个 server 重复计入（实测：patch + merged 各报一次 ⇒ 同名两条）。
    //   配置真源只有用户 patch 与 mcp.json。
    path.join(dir, "mcp.json"),
    path.join(os.homedir(), ".dsh", "mcp.json"),
  ];
  for (const f of candidates) {
    if (!(await exists(f))) continue;
    if (f.endsWith(".json")) {
      try {
        const j = JSON.parse(await fsp.readFile(f, "utf8"));
        for (const [name, cfg] of Object.entries(j.mcpServers ?? {})) {
          servers.push({
            name,
            transport: cfg.url ? "streamable-http" : "stdio",
            command: cfg.command,
            args: cfg.args,
            url: cfg.url,
            headers: cfg.headers,
            env: cfg.env,
            source: f,
          });
        }
      } catch { /* ignore */ }
      continue;
    }
    const yml = await fsp.readFile(f, "utf8");
    servers.push(...parseMcpEntriesFromYaml(yml, f));
  }
  // ★ 按 serverName 去重（同源多处声明时，先出现的优先）
  const seen = new Set();
  const deduped = servers.filter((s) => {
    if (seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  });
  return { servers: deduped };
}

/**
 * 极简解析：找含 `serverName:` 的条目块，抓同一缩进层的标量与列表键。
 *
 * ★ 支持的 `args` 三种写法（真实配置里都出现过）：
 *   ① 行内流式：`args: ["-y", "pkg"]`
 *   ② 块序列：  `args:\n  - "-y"\n  - "pkg"`
 *   ③ 折叠标量：`args:\n  - >-\n    long/path`   ← DSH 自动生成时用这种
 *   血案（2026-10-11）：旧实现只认 ①，导致 ②③ 的 args **静默丢失** ⇒
 *   桥把「缺 args 的 stdio server」交给 DSH ⇒ 子进程起不来 ⇒ `thread/start` 静默挂死。
 */
export function parseMcpEntriesFromYaml(text, source) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)-?\s*serverName:\s*(.+?)\s*$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const entry = { name: strip(m[2]), source };
    let argsMode = null;        // null | "inline" | "block"
    let argsIndent = -1;

    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const curIndent = line.length - line.trimStart().length;
      if (curIndent < indent) break;                    // 回到上层
      if (/^\s*-\s/.test(line) && curIndent <= indent) break;

      // —— 块序列内的 args 项
      if (argsMode === "block") {
        if (curIndent > argsIndent && /^\s*-\s/.test(line)) {
          let v = line.replace(/^\s*-\s*/, "");
          if (v === ">-" || v === ">" || v === "|" || v === "|-") {
            // 折叠标量：值在后续更深缩进行
            const parts = [];
            for (let k = j + 1; k < lines.length; k++) {
              const l2 = lines[k];
              if (!l2.trim()) continue;
              const i2 = l2.length - l2.trimStart().length;
              if (i2 <= curIndent) break;
              parts.push(l2.trim());
              j = k;
            }
            v = parts.join(" ");
          }
          if (v) entry.args.push(strip(v));
          continue;
        }
        // 缩进退回 ⇒ args 段结束
        argsMode = null;
      }

      const kv = /^\s*([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
      if (!kv) continue;
      const k = kv[1];
      const v = kv[2];
      if (k === "serverName") continue;
      if (["transport", "command", "url", "cwd"].includes(k)) entry[k] = strip(v);
      else if (k === "args") {
        if (v.startsWith("[")) {                        // ① 行内流式
          entry.args = v.replace(/^\[|\]$/g, "").split(",").map((x) => strip(x.trim())).filter(Boolean);
        } else if (v === "" ) {                         // ②/③ 换行形式
          entry.args = [];
          argsMode = "block";
          argsIndent = curIndent;
        } else {                                        // 单值
          entry.args = [strip(v)];
        }
      }
    }
    if (entry.name) out.push(entry);
  }
  return out;
}

function strip(v) {
  if (v == null) return v;
  v = String(v).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

/** 绝对路径 → 标准 file:// URI（Windows 盘符补成 file:///C:/...） */
export function toFileUri(p) {
  const norm = path.resolve(p).replace(/\\/g, "/");
  return norm.startsWith("/") ? `file://${norm}` : `file:///${norm}`;
}

// ══════════════════════════════════════════════════════════════════════════
// session/list 时间戳补全（★★★ 2026-10-16 血案修复：会话列表重启即"丢失"）
//
// 【血案】用户报「每次重启 VS Code，左侧会话列表内容都会丢失（顺序/分组乱）」。
//
// 【根因（源码级实证）】
//   DSH 的 ACP `session/list` 回执**只含 `{sessionId, cwd}` 两个字段**
//   （`@deepseek-ai/dsh-acp/lib/index.js` 第 1509-1512 行逐字：
//     `page.map(({ sessionId, cwd }) => ({ sessionId, cwd }))`）
//   —— 尽管其**内部排序与游标**都用到了 `header.createdAt`（第 1504/1643 行），
//      它**从未把 createdAt 暴露到响应里**。
//   ⇒ 桥 `thread/list` 的 `toSec(s.createdAt ?? ...) ?? nowSec` 恒回落到 `nowSec`
//   ⇒ **100 条会话全部被打上同一个"现在"的时间戳**（实测：唯一值数 = 1）。
//   ⇒ VS Code `codexAgent._threadToMetadata` 读 `startTime=(thread.createdAt??0)*1000`
//      ⇒ 全部会话 `startTime` 相同 ⇒ `SessionsListModelService.getNaturalSortKey`
//      排序键全等 ⇒ **顺序不确定**（每次重启重算 nowSec，列表"看起来被重置/丢内容"）。
//
// 【修法】从 DSH **自己的会话存储**读真实时间戳（只读、不写、不改 DSH 任何文件）：
//   `<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json`
//     → `record.identity.createdAt`（**毫秒**）  = 真实创建时间
//     → 文件 `mtime`                             = 真实最后更新时间
//   与 ACP 内部 `header.createdAt` **同源**（同一份持久化记录），故语义一致。
//
// 【为什么不去改 DSH 的 acp】改 `node_modules` 是易丢的（重装即回退），且此处
//   纯属"补一个 DSH 没暴露但已持久化的字段"，桥侧只读补齐更稳、零侵入。
// ══════════════════════════════════════════════════════════════════════════

/** 解析 DSH 会话存储目录（`<dshHome>/storages/session_projcache/sessions`） */
export function resolveSessionStoreDir(opts = {}) {
  const dshHome = opts.dshHome ?? process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
  return path.join(dshHome, "storages", "session_projcache", "sessions");
}

/**
 * 读取单个会话文件的真实时间戳。**只读**；失败一律返回 null（调用方回落）。
 *
 * @param {string} sessionId 裸 sessionId（可带 `session-` 前缀，内部会剥）
 * @param {{dshHome?:string}} [opts]
 * @returns {Promise<{createdAtMs:number, updatedAtMs:number}|null>}
 */
export async function readSessionTimestamps(sessionId, opts = {}) {
  const dir = resolveSessionStoreDir(opts);
  const bare = String(sessionId ?? "").replace(/^session-/, "");
  if (!bare) return null;
  // DSH 落盘文件名有两种形态：`<uuid>.json` 与 `session-<uuid>.json`（世代差异），都试。
  const candidates = [
    path.join(dir, `${bare}.json`),
    path.join(dir, `session-${bare}.json`),
  ];
  for (const file of candidates) {
    try {
      const st = await fsp.stat(file);
      let createdAtMs = st.birthtimeMs || st.ctimeMs || st.mtimeMs;
      try {
        // 只在需要时解析 JSON：优先取 identity.createdAt（语义最准）
        const raw = await fsp.readFile(file, "utf8");
        const parsed = JSON.parse(raw);
        const t = parsed?.record?.identity?.createdAt;
        if (typeof t === "number" && Number.isFinite(t) && t > 0) createdAtMs = t;
      } catch { /* JSON 坏/截断 ⇒ 用 stat 时间兜底 */ }
      return {
        createdAtMs: Math.round(createdAtMs),
        updatedAtMs: Math.round(st.mtimeMs || createdAtMs),
      };
    } catch { /* 试下一个候选名 */ }
  }
  return null;
}

/**
 * 批量补时间戳：返回 `Map<sessionId(裸), {createdAtMs, updatedAtMs}>`。
 * 用于 `thread/list` 一次补全整页（避免逐条 stat 阻塞）。
 *
 * ★ 一次性 readdir 建索引（`<裸id>.json`），比逐条 stat 快一个量级。
 *
 * @param {{dshHome?:string}} [opts]
 * @returns {Promise<Map<string,{createdAtMs:number, updatedAtMs:number}>>}
 */
export async function readSessionTimestampIndex(opts = {}) {
  const dir = resolveSessionStoreDir(opts);
  const index = new Map();
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return index; // 目录不存在 ⇒ 空索引（调用方回落 nowSec，行为不退化）
  }
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith(".json")) continue;
    const bare = ent.name.replace(/^session-/, "").replace(/\.json$/, "");
    const full = path.join(dir, ent.name);
    try {
      const st = await fsp.stat(full);
      let createdAtMs = st.birthtimeMs || st.ctimeMs || st.mtimeMs;
      try {
        const raw = await fsp.readFile(full, "utf8");
        const parsed = JSON.parse(raw);
        const t = parsed?.record?.identity?.createdAt;
        if (typeof t === "number" && Number.isFinite(t) && t > 0) createdAtMs = t;
      } catch { /* 用 stat 兜底 */ }
      index.set(bare, {
        createdAtMs: Math.round(createdAtMs),
        updatedAtMs: Math.round(st.mtimeMs || createdAtMs),
      });
    } catch { /* 单条失败跳过 */ }
  }
  return index;
}
