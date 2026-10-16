/**
 * 探针：tagEventsWithTurn 到底补号了没有？
 */
import { readTranscript, extractConversationEvents, extractTurnBoundaries, tagEventsWithTurn } from '../src/transcript.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:/Users/liuyue/.dsh/sessions';
const TARGETS = ['3b9a96cffd', 'ef5f634239', '916caa47de', '785c674d8c'];
const dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());

for (const d of dirs) {
  let sids = [];
  try { sids = fs.readdirSync(path.join(ROOT, d.name), { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name); } catch { continue; }
  for (const sid of sids) {
    const short = sid.slice(-10);
    if (!TARGETS.includes(short)) continue;
    const { records } = await readTranscript(sid, null);
    const { events } = extractConversationEvents(records);
    const b = extractTurnBoundaries(records);
    const tagged = tagEventsWithTurn(events, records);
    console.log(`\n===== ${short} =====`);
    console.log(`records seq 槽位: ${records.map((r) => `${r.seq ?? '?'}:${r.type}`).filter((x) => /turn\/|user\/|assistant\//.test(x)).join(' | ')}`);
    console.log(`events(turn): ${JSON.stringify(events.map((e) => [e.kind, e.seq, e.turn]))}`);
    console.log(`tagged(turn): ${JSON.stringify(tagged.map((e) => [e.kind, e.seq, e.turn]))}`);
    console.log(`边界 seq 范围: ${JSON.stringify(b.turns.map((t) => [t.turn, t.startSeq, t.endSeq, t.startedAtMs, t.endedAtMs]))}`);
  }
}
