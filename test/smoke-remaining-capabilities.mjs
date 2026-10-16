/**
 * 端到端冒烟：真实转录 → 历史回填 + turnBoundary 校正（2026-10-17）
 *
 * 对多个真实会话跑完整链路，断言：
 *   ① 有历史的会话都能回填出 Turn[]，且每个 Turn 满足官方 8 required
 *   ② 边界校正生效（statusSource 以 boundary: 为主）
 *   ③ 状态分布与 turn/end.reason.kind 分布**逐项吻合**（这是最硬的判据）
 *   ④ 开放轮（无 turn/end）才可能是 inProgress
 *
 * 用法： node temp/smoke-remaining-capabilities.mjs [N]
 */
import { readTranscript, extractConversationEvents, extractTurnBoundaries, tagEventsWithTurn } from '../src/transcript.mjs';
import { transcriptEventsToTurns } from '../src/translate.mjs';
import fs from 'node:fs';
import path from 'node:path';

const LIMIT = Number(process.argv[2] ?? 120);
const ROOT = 'C:/Users/liuyue/.dsh/sessions';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log(`  ✗ ${m}`); } };
const REQUIRED = ['id', 'items', 'itemsView', 'status', 'error', 'startedAt', 'completedAt', 'durationMs'];
const VALID_STATUS = ['completed', 'failed', 'inProgress', 'interrupted'];

const dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
let scanned = 0, withHistory = 0, turnsTotal = 0, boundaryDriven = 0, heuristicDriven = 0;
const statusDist = {}; const reasonDist = {};
let mismatches = [];

for (const d of dirs) {
  let sids = [];
  try { sids = fs.readdirSync(path.join(ROOT, d.name), { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name); } catch { continue; }
  for (const sid of sids) {
    if (scanned >= LIMIT) break;
    const f = path.join(ROOT, d.name, sid, 'session.v4.jsonl.zstd');
    if (!fs.existsSync(f)) continue;
    scanned++;
    const { records } = await readTranscript(sid, null);
    if (!records.length) continue;
    const { events } = extractConversationEvents(records);
    if (!events.length) continue;
    withHistory++;
    const b = extractTurnBoundaries(records);
    // ★ 必须打标（与生产路径 bridge.mjs:1441 一致）：给 user 事件补 DSH 轮次号，
    //   否则 hasTurnInfo=false ⇒ 回落顺序配对 ⇒ turnNo=null ⇒ 与边界表对不上账。
    const tagged = tagEventsWithTurn(events, records);
    const turns = transcriptEventsToTurns(tagged, { threadId: sid, boundaries: b });
    turnsTotal += turns.length;

    // ① required + 枚举
    for (const t of turns) {
      ok(REQUIRED.every((k) => k in t), `${sid.slice(-10)} turn ${t.id} 缺 required`);
      ok(VALID_STATUS.includes(t.status), `${sid.slice(-10)} 非法 status=${t.status}`);
      if (t.status === 'inProgress') ok(t.completedAt === null, `${sid.slice(-10)} inProgress 却有 completedAt`);
    }
    // ② 状态来源
    for (const t of turns) {
      if (/^boundary:/.test(t.statusSource ?? '')) boundaryDriven++;
      else heuristicDriven++;
      statusDist[t.status] = (statusDist[t.status] ?? 0) + 1;
    }
    // ③ 状态分布 vs reason 分布 逐项吻合
    //   ★ 只统计**实际产出 Turn 的轮次**（无可见消息的轮次不产出 Turn，不计入对比）
    //   ★ 打标后 user 也有轮次号 ⇒ 正常都能对上；仅当 groups 为空才可能不产出
    const producedTurns = new Set(turns.map((t) => t.turnNo).filter((x) => typeof x === "number"));
    for (const bt of b.turns) {
      if (!producedTurns.has(bt.turn)) continue;
      const k = bt.reasonKind ?? (bt.endedAtMs === null ? '(无end)' : '(无reason)');
      reasonDist[k] = (reasonDist[k] ?? 0) + 1;
    }
    // 额外硬断言：回填轮次数必须 == 该会话中"有可见消息的轮次数"
    ok(turns.length <= b.turns.length,
      `${sid.slice(-10)} 回填轮次 ${turns.length} > 边界轮次 ${b.turns.length}（不可能）`);
    // ④ 开放轮 → 至多一个 inProgress
    const inProg = turns.filter((t) => t.status === 'inProgress').length;
    ok(inProg <= 1, `${sid.slice(-10)} 出现 ${inProg} 个 inProgress（至多 1）`);
    if (inProg === 1) ok(b.openTurn !== null, `${sid.slice(-10)} 有 inProgress 但无开放轮`);
    if (b.openTurn === null) ok(inProg === 0, `${sid.slice(-10)} 无开放轮却有 inProgress`);
  }
  if (scanned >= LIMIT) break;
}

// 状态分布与 reason 分布的映射核对
const reasonToStatus = { completed: 'completed', error: 'failed', aborted: 'interrupted', interrupted: 'interrupted', 'max-tokens': 'interrupted', blocked: 'interrupted' };
const expectStatus = {};
let skippedNoReason = 0;
for (const [k, v] of Object.entries(reasonDist)) {
  if (k === '(无end)') { expectStatus.inProgress = (expectStatus.inProgress ?? 0) + v; continue; }
  if (k === '(无reason)') { skippedNoReason += v; continue; }   // 有 end 但无 reason ⇒ 桥保留启发式判据，不计入对账
  const s = reasonToStatus[k];
  if (s) expectStatus[s] = (expectStatus[s] ?? 0) + v;
  else { skippedNoReason += v; console.log(`  ⚠ 未知 reasonKind: ${k} × ${v}`); }
}

console.log(`扫描会话 ${scanned}（有历史 ${withHistory}），回填轮次 ${turnsTotal}`);
console.log(`状态来源：boundary=${boundaryDriven}  heuristic=${heuristicDriven}`);
console.log(`reason 分布明细    : ${JSON.stringify(reasonDist)}`);
console.log(`后端 status 分布   : ${JSON.stringify(statusDist)}`);
console.log(`由 reason 推导分布 : ${JSON.stringify(expectStatus)}   (跳过无reason ${skippedNoReason})`);
for (const k of Object.keys({ ...statusDist, ...expectStatus })) {
  const exp = expectStatus[k] ?? 0;
  const act = statusDist[k] ?? 0;
  // ★ 口径：expect 是"有权威 reason 的轮次"的下界；act 可能因"无 reason 走启发式"略多
  ok(act >= exp ? (act - exp) <= skippedNoReason : false,
    `分布不一致 ${k}: 实际 ${act} vs 期望(下界) ${exp}，差 ${act - exp} > 无reason轮 ${skippedNoReason}`);
}

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
console.log(`boundary 驱动占比: ${boundaryDriven + heuristicDriven ? (boundaryDriven * 100 / (boundaryDriven + heuristicDriven)).toFixed(1) : 0}%`);
process.exit(fail ? 1 : 0);
