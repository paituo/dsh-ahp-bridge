/**
 * 量化风险：有多少会话会走到"无轮次号 + 位置配对 + 边界表命中"这条不可靠路径？
 * 判据：turns[].turnNo === null（说明走 else 分支）但 boundaries.turns 非空
 */
import { readTranscript, extractConversationEvents, extractTurnBoundaries, tagEventsWithTurn } from '../src/transcript.mjs';
import { transcriptEventsToTurns } from '../src/translate.mjs';
import fs from 'node:fs';
import path from 'node:path';

const LIMIT = Number(process.argv[2] ?? 400);
const ROOT = 'C:/Users/liuyue/.dsh/sessions';
const dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());

let scanned = 0, risky = 0;
const samples = [];

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
    const tagged = tagEventsWithTurn(events, records);
    const turns = transcriptEventsToTurns(tagged, { threadId: sid, boundaries: b });

    const nullTurnNo = turns.filter((t) => t.turnNo === null).length;
    if (nullTurnNo > 0 && b.turns.length > 0) {
      risky++;
      if (samples.length < 8) {
        samples.push({ sid: sid.slice(-10), nullTurnNo, turns: turns.length, bTurns: b.turns.map((t) => t.turn), statuses: turns.map((t) => `${t.turnNo}:${t.status}:${(t.statusSource ?? '').split(':')[0]}`) });
      }
    }
  }
  if (scanned >= LIMIT) break;
}

console.log(`扫描 ${scanned}，走"无轮次号+位置配对+边界命中"的会话数: ${risky}`);
for (const s of samples) {
  console.log(`  ${s.sid} nullTurnNo=${s.nullTurnNo} turns=${s.turns} bTurns=[${s.bTurns}]`);
  console.log(`     ${JSON.stringify(s.statuses)}`);
}
