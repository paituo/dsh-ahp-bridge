/**
 * 诊断：为什么 statusDist 与 expectStatus 对不上
 * 逐会话打印：turns.length / b.turns.length / 产出轮次的 reasonKind 明细 / turn.status 明细
 */
import { readTranscript, extractConversationEvents, extractTurnBoundaries } from '../src/transcript.mjs';
import { transcriptEventsToTurns } from '../src/translate.mjs';
import fs from 'node:fs';
import path from 'node:path';

const LIMIT = Number(process.argv[2] ?? 30);
const ROOT = 'C:/Users/liuyue/.dsh/sessions';
const dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());

let scanned = 0;
const reasonDist = {}; const statusDist = {};
let noStatusSource = 0;
const rows = [];

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
    const b = extractTurnBoundaries(records);
    const turns = transcriptEventsToTurns(events, { threadId: sid, boundaries: b });

    const produced = new Set(turns.map((t) => t.turnNo));
    const boundTurns = b.turns.filter((bt) => produced.has(bt.turn));
    const tStatus = turns.map((t) => `${t.turnNo}:${t.status}:${(t.statusSource ?? '').split(':')[0]}`);

    // 明细
    const rk = boundTurns.map((bt) => bt.reasonKind ?? (bt.endedAtMs === null ? 'NOEND' : 'NOREASON'));
    for (const k of rk) reasonDist[k] = (reasonDist[k] ?? 0) + 1;
    for (const t of turns) statusDist[t.status] = (statusDist[t.status] ?? 0) + 1;
    for (const t of turns) if (!t.statusSource) noStatusSource++;

    if (turns.length !== boundTurns.length) {
      rows.push({ sid: sid.slice(-10), turns: turns.length, bound: boundTurns.length, tStatus, rk });
    }
  }
  if (scanned >= LIMIT) break;
}

console.log(`扫描 ${scanned}`);
console.log(`producedTurns 口径 reasonDist: ${JSON.stringify(reasonDist)}`);
console.log(`全部 turns 口径 statusDist  : ${JSON.stringify(statusDist)}`);
console.log(`无 statusSource 的 turn      : ${noStatusSource}`);
console.log(`\n轮次数不一致的会话（${rows.length} 个）:`);
for (const r of rows.slice(0, 20)) {
  console.log(`  ${r.sid} turns=${r.turns} bound=${r.bound}`);
  console.log(`     status: ${JSON.stringify(r.tStatus)}`);
  console.log(`     reason: ${JSON.stringify(r.rk)}`);
}
