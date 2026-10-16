/**
 * DSH 会话转录（transcript）读取器 —— 只读，用于给 `thread/read` 回填历史。
 *
 * ============================ 血案（2026-10-16） ============================
 *
 * 【症状】左侧会话列表有会话，点进去**右侧没有任何消息**（空白）。
 *
 * 【根因三环】
 *   ① VS Code 恢复历史 chat 时调 `thread/read`（本次实测 **1115 次**）。
 *   ② 桥的 `thread/read` 里 `const res = await dsh.listTurns?.(sid)` ——
 *      而 `dsh-acp-client.mjs` **根本没有 listTurns 方法**
 *      ⇒ 可选链短路 ⇒ `turns` 恒为 `[]` ⇒ 每次回空历史。
 *   ③ VS Code 日志逐字佐证：`Restored session ahp-session:/<id> with 0 turns`。
 *
 * 【为什么 ACP 侧拿不到历史】
 *   已装 `@deepseek-ai/dsh-acp` **只实现** `session/{new,list,resume,close,
 *   set_config_option,prompt,cancel,update,event}`，**没有 `session/load`**，
 *   且 `session/list` 回执只有 `{sessionId,cwd}`。⇒ 历史只能从**落盘转录**读。
 *
 * 【转录在哪】
 *   `<DSH_HOME>/sessions/<escaped-cwd>/<sessionId>/session.v4.jsonl.zstd`
 *   ★ 与 `storages/session_projcache/sessions/<id>.json`（只有元数据 rows、
 *     **不含任何消息**）是**两套不同的存储** —— 别找错地方。
 *   ★ 目录名是 cwd 的**转义形式**：`/` → `-`，且非 ASCII 走 `~XXXX~`（UTF-16 码元 hex）。
 *
 * 【格式 = 多帧 zstd】
 *   文件是**多个 zstd frame 首尾相接**（DSH 每写一批 append 一个 frame）。
 *   `zlib.zstdDecompressSync(整文件)` 只解**第一帧**（实测 40KB → 190 字节，1 行）。
 *   必须按 magic `28 b5 2f fd` 找边界、**逐帧解压**再拼接（实测 11 帧 → 35 行）。
 *
 * 【记录类型（实测）】
 *   session / turn/start / user/message / assistant/message / turn/end /
 *   step/start / step/end / system/message / session/title / sandbox/mode /
 *   approval/policy / hook/* / request/* / permission/preset / assistant/attempt …
 *   本模块只消费：`turn/start`、`user/message`、`assistant/message`、`turn/end`。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** DSH home：$DSH_HOME > ~/.dsh */
export function resolveDshHome(opts = {}) {
  return opts.dshHome ?? process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
}

/**
 * cwd → DSH 会话目录名（**逐字对齐 DSH 的转义规则**）。
 *
 *   规则：① 非 ASCII 字符 → `~` + 其 UTF-16 码元 的 4 位大写 hex；
 *         ② 分隔符 `\` `/` `:` → `-`（连续分隔符合并为一个 `-`，首尾保留一个 `-`）；
 *
 * 实测样例：
 *   `C:\Users\liuyue`                     → `--C-Users-liuyue--`
 *   `E:\分析数据\DeepSeek-Harness-VSCode\dev`
 *     → `--E-~5206~6790~6570~636E-DeepSeek-Harness-VSCode-dev--`
 *     （分=5206 析=6790 数=6570 据=636E）
 *
 * ★ 关键：末尾**补 `--`**（因 Windows 盘符 `E:` 前也补 `-`，形成 `--E-...-dev--`）。
 */
export function cwdToSessionDirKey(cwd) {
  if (!cwd) return null;
  let out = "";
  for (const ch of String(cwd)) {
    const code = ch.codePointAt(0);
    if (code > 0x7f) {
      // 非 ASCII：每个 UTF-16 码元前缀 `~XXXX`（**无收尾 `~`**）。
      //   实测：`分析数据` → `~5206~6790~6570~636E`；`@` → `~0040`。
      //   （`~` 只作前缀，靠下一个 `~` 或分隔符收束。）
      for (let i = 0; i < ch.length; i++) {
        out += "~" + ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
      }
    } else if (ch === "\\" || ch === "/" || ch === ":") {
      out += "-";
    } else {
      out += ch;
    }
  }
  // ★ 正文内部连续 `-` 压成一个；去掉正文首尾 `-`；再首尾各包 **两个** `-`
  //   （实测形态恒为 `--<body>--`，如 `--C-Users-liuyue--`）。
  //   ★ 注意：盘符大小写由**创建时**的 cwd 决定（实测存在 `--c-...` 小写盘符目录），
  //     故解析时不做强制大写（保持原样），由 `resolveTranscriptPath` 做大小写兜底查找。
  const body = out.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return `--${body}--`;
}

/** 定位某会话的转录文件候选（返回候选路径数组；调用方逐个试） */
export function resolveTranscriptPath(sessionId, cwd, opts = {}) {
  const home = resolveDshHome(opts);
  const key = opts.sessionDirKey ?? cwdToSessionDirKey(cwd);
  const out = [];
  if (key) out.push(path.join(home, "sessions", key, sessionId, "session.v4.jsonl.zstd"));
  return out;
}

/**
 * 大小写不敏感地解析 `sessions/<dirKey>/<sessionId>` 真实路径。
 *
 * ★ 为什么需要：盘符大小写由**创建会话时**的 cwd 决定，实测同时存在
 *   `--C-Users-liuyue-...--` 与 `--c-Users-liuyue-...--`（同一台机、两个会话）。
 *   若只按字面拼路径 ⇒ 一半会话读不到历史。故对目录名做一次不敏感匹配。
 */
async function resolveCaseInsensitive(dir, name) {
  try {
    const want = name.toLowerCase();
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    const hit = ents.find((e) => e.name.toLowerCase() === want);
    return hit ? path.join(dir, hit.name) : null;
  } catch {
    return null;
  }
}

/**
 * 多帧 zstd 解压：按 magic 找边界，逐帧解压后拼接。
 * ★ 必须这样解 —— 整文件一次性解只出第一帧（血案见文件头）。
 */
export function decompressMultiFrameZstd(raw) {
  const offs = [];
  for (let i = 0; i + 4 <= raw.length; i++) {
    if (raw.compare(ZSTD_MAGIC, 0, 4, i, i + 4) === 0) offs.push(i);
  }
  if (!offs.length) return "";
  offs.push(raw.length);
  let text = "";
  for (let k = 0; k < offs.length - 1; k++) {
    // 正常情况：帧边界精确 ⇒ 单帧解压成功
    try {
      text += zlib.zstdDecompressSync(raw.subarray(offs[k], offs[k + 1])).toString("utf8");
      continue;
    } catch { /* magic 可能是帧内伪命中 ⇒ 合并到下一帧再试 */ }
    // 合并后续帧直到成功（最多多试 3 帧，避免 O(n²) 爆炸）
    for (let span = 2; span <= 4 && k + span - 1 < offs.length - 1; span++) {
      try {
        text += zlib.zstdDecompressSync(raw.subarray(offs[k], offs[k + span])).toString("utf8");
        k += span - 1;
        break;
      } catch { /* 继续扩 */ }
    }
  }
  return text;
}

/** 解析转录文本 → 记录数组（坏行跳过，不抛） */
export function parseTranscriptText(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o.type === "string") out.push(o);
    } catch { /* 半截行（写入中断）⇒ 跳过 */ }
  }
  return out;
}

/**
 * 读取并解析某会话的转录记录。
 * 解析顺序：① 字面 dirKey 路径 → ② 大小写不敏感 dirKey → ③ 全局反查 sessionId。
 * @returns {Promise<{records:Array, path:string|null, error:string|null}>}
 */
export async function readTranscript(sessionId, cwd, opts = {}) {
  const home = resolveDshHome(opts);
  const sessionsRoot = path.join(home, "sessions");

  // ① 字面候选
  for (const p of resolveTranscriptPath(sessionId, cwd, opts)) {
    const r = await tryRead(p);
    if (r) return r;
  }
  // ② dirKey 大小写不敏感（盘符大小写差异）
  const key = opts.sessionDirKey ?? cwdToSessionDirKey(cwd);
  if (key) {
    const realDir = await resolveCaseInsensitive(sessionsRoot, key);
    if (realDir) {
      const r = await tryRead(path.join(realDir, sessionId, "session.v4.jsonl.zstd"));
      if (r) return r;
    }
  }
  // ③ 全局反查（cwd 缺失/不符时兜底）
  const found = await findTranscriptBySessionId(sessionId, opts);
  if (found) {
    const r = await tryRead(found);
    if (r) return r;
  }
  return { records: [], path: null, error: null };
}

/** 试读一个转录路径；命中返回 {records,path,error}，不存在返回 null */
async function tryRead(p) {
  try {
    const raw = await fsp.readFile(p);
    return { records: parseTranscriptText(decompressMultiFrameZstd(raw)), path: p, error: null };
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    return { records: [], path: p, error: String(e?.message ?? e) };
  }
}

/** 同步版（供不便 await 的收尾路径；不含大小写不敏感兜底） */
export function readTranscriptSync(sessionId, cwd, opts = {}) {
  for (const p of resolveTranscriptPath(sessionId, cwd, opts)) {
    try {
      const raw = fs.readFileSync(p);
      return { records: parseTranscriptText(decompressMultiFrameZstd(raw)), path: p, error: null };
    } catch (e) {
      if (e?.code === "ENOENT") continue;
      return { records: [], path: p, error: String(e?.message ?? e) };
    }
  }
  return { records: [], path: null, error: null };
}

/** 枚举 DSH sessions 根下所有 `session.v4.jsonl.zstd`（供按 sessionId 反查，无需 cwd） */
export async function findTranscriptBySessionId(sessionId, opts = {}) {
  const home = resolveDshHome(opts);
  const root = path.join(home, "sessions");
  let dirs;
  try {
    dirs = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const p = path.join(root, d.name, sessionId, "session.v4.jsonl.zstd");
    try {
      await fsp.access(p);
      return p;
    } catch { /* 继续找 */ }
  }
  return null;
}

// ---------------------------------------------------------------- 记录 → 中间态

/** 从 `content` 数组里抽纯文本（DSH 消息 content = [{type:'text',text}]） */
function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (typeof c === "string" ? c : c?.type === "text" ? (c.text ?? "") : ""))
    .join("");
}

/** 毫秒 → 秒（codex 协议全用秒）；已是秒则原样 */
function toSec(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
}

/**
 * 转录记录 → 归一化的「会话事件」列表（按 seq 升序）。
 * 每条：{kind:'user'|'assistant', id, text, turn, timeMs, seq}
 *
 * ★★ 注入消息过滤（血案级）：DSH 把**上下文注入**也记成 `user/message`，靠
 *    `data.source.kind` 区分（实测）：
 *      · `{kind:'user'}`            → **真人输入**（唯一要保留的）
 *      · `{kind:'runtime-context'}` → 沙箱/审批/记忆快照（每轮都注入，超大）
 *      · `{kind:'skill-catalog'}`   → 技能目录（6KB+）
 *      · `{kind:'model-selection'}` → 「[model changed: …]」提示
 *    若不过滤，恢复的历史里会塞满这些巨型内部提示 ⇒ 用户看到的是"系统噪音"而非自己的对话。
 *    ★ 注意注入的 `role` 同样是 `user`，**只有 `source.kind` 能判**。
 */
export function extractConversationEvents(records) {
  const events = [];
  for (const r of records) {
    const t = r.type;
    const d = r.data ?? {};
    if (t === "user/message") {
      if ((d.source?.kind ?? "user") !== "user") continue;   // ★ 过滤注入
      const text = contentToText(d.content);
      if (!text) continue;
      events.push({
        kind: "user",
        id: d.id ?? `user-${r.seq ?? events.length}`,
        text,
        turn: d.turn ?? null,
        timeMs: r.time ?? null,
        seq: r.seq ?? events.length,
      });
    } else if (t === "assistant/message") {
      const text = contentToText(d.message?.content);
      if (!text) continue;   // ★ 只保留有文本的（纯工具调用轮次无 text ⇒ 跳过）
      events.push({
        kind: "assistant",
        id: d.message?.id ?? `assistant-${r.seq ?? events.length}`,
        text,
        turn: d.turn ?? null,
        timeMs: r.time ?? null,
        seq: r.seq ?? events.length,
      });
    }
  }
  events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return { events };
}

/**
 * ★★★ 2026-10-17 新增：**按 DSH 轮次号给事件打标**（用转录的权威边界，而非顺序配对）。
 *
 * ============================ 为什么必须做 ============================
 *   实测（2026-10-17 探针，会话 `...098f3a50eb` / `...bb5927f32b`）：
 *     · `assistant/message.data.turn` **有**权威轮次号（1,2,2,2,…,5）
 *     · `user/message.data.turn` **恒为 null**（DSH 不记 user 的 turn）
 *     · 一轮里可有**多条** assistant/message（长 agentic 轮，实测一轮 15 条！）
 *     · 一轮里可有**多条**真人 user 消息（实测 5 轮 / 11 条 user）
 *   ⇒ 「一个 user + 其后 assistant = 一轮」的顺序配对在这类会话上**必然过分裂**
 *     （实测 5 轮被拆成 17 轮）。
 *
 * ============================ 打标规则 ============================
 *   · assistant 事件：直接取 `data.turn`（权威）。
 *   · user 事件：按 **seq 落入哪一段轮次区间** 归属 ——
 *       轮 t 的区间 = (turn/start(t).seq, turn/end(t).seq]（左开右闭）。
 *       落在所有区间之前（首轮 start 之前）⇒ 归入第一个轮次
 *       （用户消息先于 turn/start 记录是正常的：inbox 接纳早于轮次开启）。
 *   · 无边界信息（boundaries 缺省）⇒ `turn` 保持 null，由调用方回落顺序配对。
 *
 * @param {Array} events  extractConversationEvents 的产物
 * @param {{turns:Array<{turn:number}>, seqRanges?:Map<number,{startSeq:number,endSeq:number}>}} boundaries
 * @param {Array} records transcript 记录（用于取 turn/start / turn/end 的 seq）
 * @returns {Array} 打标后的 events（**原地不改**，返回新数组）
 */
export function tagEventsWithTurn(events, records) {
  // ① 从 records 建 轮次号 → { startSeq, endSeq, startTime, endTime }
  const ranges = new Map();
  for (const r of records) {
    const d = r.data ?? {};
    const t = typeof d.turn === "number" ? d.turn : null;
    if (t === null) continue;
    if (r.type === "turn/start") {
      const cur = ranges.get(t) ?? {};
      cur.startSeq = r.seq ?? null;
      cur.startTime = r.time ?? null;
      ranges.set(t, cur);
    } else if (r.type === "turn/end") {
      const cur = ranges.get(t) ?? {};
      cur.endSeq = r.seq ?? null;
      cur.endTime = r.time ?? null;
      ranges.set(t, cur);
    }
  }
  if (!ranges.size) return events.map((e) => ({ ...e }));   // 无边界 ⇒ 原样（turn 保持 null）

  // ② 轮次按 startSeq 升序（turn 号单调，但 seq 才是排序真源）
  const ordered = [...ranges.entries()]
    .map(([turn, v]) => ({ turn, startSeq: v.startSeq ?? 0, endSeq: v.endSeq ?? Number.MAX_SAFE_INTEGER, startTime: v.startTime ?? null, endTime: v.endTime ?? null }))
    .sort((a, b) => a.startSeq - b.startSeq);

  /** 给一个 seq 找所属轮次号（区间：startSeq < seq <= endSeq；早于首轮归首轮） */
  const turnForSeq = (seq) => {
    if (typeof seq !== "number") return null;
    // 早于第一个轮次开启 ⇒ 归入首轮（inbox 接纳早于 turn/start 是正常的）
    if (seq <= ordered[0].startSeq) return ordered[0].turn;
    // 区间归属：取最后一个 startSeq < seq 的轮次
    let hit = null;
    for (const o of ordered) { if (o.startSeq < seq) hit = o.turn; else break; }
    return hit ?? ordered[0].turn;
  };

  return events.map((e) => {
    // assistant 自带权威 turn ⇒ 优先
    if (typeof e.turn === "number") return { ...e };
    return { ...e, turn: turnForSeq(e.seq) };
  });
}

/** 会话标题（转录里的 session/title，缺失则回落首条用户消息） */
export function extractSessionTitle(records, events) {
  for (const r of records) {
    if (r.type === "session/title") {
      const t = r.data?.title ?? r.data?.text ?? null;
      if (t) return String(t);
    }
  }
  const firstUser = events.find((e) => e.kind === "user");
  return firstUser ? firstUser.text.slice(0, 80) : null;
}

/**
 * ★★★ 2026-10-17 新增：**权威轮次边界**（对齐 DSH `turnBoundary` 投影的思想）。
 *
 * ============================ 为什么必须做 ============================
 *   此前 `transcriptEventsToTurns` 靠「**顺序配对**」（一个 user + 其后 assistant = 一轮）
 *   来猜轮次边界 —— 那是**启发式**，在三种真实情形下必错：
 *     ① 一轮内 user 消息多于一条（steering / 中断后补发）；
 *     ② 工具往返轮次里 assistant/message 有多条；
 *     ③ 轮次因 error / aborted / max-tokens 终结 ⇒ 用户问了但**永无回答**
 *        （启发式会把它和下一轮的 assistant 错配成一轮）。
 *   ⇒ 而 DSH 转录里**本来就记着权威边界**：`turn/start` 与 `turn/end`，
 *     且 `turn/end.data.reason` 明确给出终结原因。
 *
 * ============================ 实测形态（2026-10-17 探针） ============================
 *   `{type:"turn/start", seq, time, data:{turn:1}}`
 *   `{type:"turn/end",   seq, time, data:{turn:1, reason:{kind:"completed"|"error"|
 *                                                  "max-tokens"|"aborted"|"blocked"|"interrupted"}}}`
 *   `{type:"step/start", seq, time, data:{turn:1, step:1}}`
 *   `{type:"step/end",   seq, time, data:{turn:1, step:1}}`
 *   ★ 实测 21 轮的会话：21 个 turn/start、21 个 turn/end，
 *     reason 分布 completed=14, error=3, max-tokens=3, aborted=1 ⇒ **边界齐全可靠**。
 *   ★ 轮内可有**多个 step**（实测 turn 1 有 step 1、step 2）。
 *
 * ============================ 语义映射（对齐官方 TurnStatus） ============================
 *   reason.kind → codex `TurnStatus`（官方枚举 completed|failed|interrupted|inProgress）：
 *     · `completed`                     → `completed`
 *     · `error`                         → `failed`（真错）
 *     · `aborted` / `interrupted`       → `interrupted`（用户/上游中止）
 *     · `max-tokens` / `blocked` / 其它 → `interrupted`
 *       （★ 不映射成 failed：官方 `mapTurnCompleted` 只在 `failed && turn.error` 时渲染
 *        ChatError；max-tokens 不是错误，是"被截断"，标 failed 会让 UI 弹红框误报。）
 *   ★ **无 `turn/end` 的轮**（最后一轮正在跑）→ `inProgress`。
 *     这是**唯一**能确证"进行中"的判据 —— 不再是"最后一条且无 assistant"的猜测。
 *
 * @param {Array} records transcript 记录
 * @returns {{turns:Array<{turn:number, startedAtMs:number, endedAtMs:number|null,
 *           reasonKind:string|null, status:string|null, steps:number}>,
 *           openTurn:number|null, lastTurn:number,
 *           lastStepBoundary:{turn:number,step:number,kind:'start'|'end'}|null}}
 */
export function extractTurnBoundaries(records) {
  /** @type {Map<number, object>} turn 号 → 边界事实 */
  const byTurn = new Map();
  let lastStepBoundary = null;

  for (const r of records) {
    const d = r.data ?? {};
    const t = typeof d.turn === "number" ? d.turn : null;
    if (t === null) continue;
    switch (r.type) {
      case "turn/start": {
        if (!byTurn.has(t)) {
          byTurn.set(t, { turn: t, startedAtMs: r.time ?? null, endedAtMs: null, reasonKind: null, status: null, steps: 0 });
        }
        break;
      }
      case "turn/end": {
        const cur = byTurn.get(t) ?? { turn: t, startedAtMs: null, endedAtMs: null, reasonKind: null, status: null, steps: 0 };
        cur.endedAtMs = r.time ?? null;
        cur.reasonKind = d.reason?.kind ?? null;
        cur.status = turnEndReasonToStatus(d.reason?.kind);
        byTurn.set(t, cur);
        break;
      }
      case "step/start": {
        const cur = byTurn.get(t);
        if (cur) cur.steps += 1;
        if (typeof d.step === "number") lastStepBoundary = { turn: t, step: d.step, kind: "start" };
        break;
      }
      case "step/end": {
        if (typeof d.step === "number") lastStepBoundary = { turn: t, step: d.step, kind: "end" };
        break;
      }
      default: break;
    }
  }

  const turns = [...byTurn.values()].sort((a, b) => a.turn - b.turn);
  // 开放轮 = 有 start 无 end 的**最大** turn 号（正常至多一个）
  let openTurn = null;
  for (const t of turns) if (t.endedAtMs === null && t.startedAtMs !== null) openTurn = t.turn;
  const lastTurn = turns.length ? turns[turns.length - 1].turn : 0;

  return { turns, openTurn, lastTurn, lastStepBoundary };
}

/**
 * `turn/end.reason.kind` → 官方 `TurnStatus`。
 * ★ 映射原则：**只有真错才 failed**；截断/中止一律 interrupted。
 *   （`max-tokens` 不是错误；标 failed 会让 UI 弹 ChatError 红框，属误报。）
 *   官方枚举：completed | failed | interrupted | inProgress
 */
export function turnEndReasonToStatus(reasonKind) {
  switch (reasonKind) {
    case "completed": return "completed";
    case "error": return "failed";
    case "aborted":
    case "interrupted":
    case "max-tokens":
    case "blocked":
      return "interrupted";
    // reason 缺失（旧格式/半截写入）⇒ **中性回落 null**，由调用方保留原判据。
    // ★ 绝不用"看起来合理"的动态值兜底（铁律：兜底值必须中性）。
    default: return null;
  }
}
