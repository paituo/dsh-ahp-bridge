/**
 * 探针：null-turnNo 会话的真实形状
 *   为何事件无轮次号（是没 assistant/message 吗？），边界又是怎样的？
 */
import { readTranscript, extractConversationEvents, extractTurnBoundaries } from '../src/transcript.mjs';
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
    if (!records.length) continue;
    const { events } = extractConversationEvents(records);
    const b = extractTurnBoundaries(records);
    console.log(`\n===== ${short} =====`);
    console.log(`records=${records.length} events=${events.length}`);
    console.log(`记录类型分布: ${JSON.stringify(records.reduce((a, r) => { const k = r.type ?? r.kind ?? '?'; a[k] = (a[k] ?? 0) + 1; return a; }, {}))}`);
    console.log(`事件: ${events.map((e) => `${e.kind}#${e.turn ?? '-'}`).join(', ')}`);
    console.log(`边界: turns=${b.turns.length} openTurn=${b.openTurn} lastTurn=${b.lastTurn}`);
    for (const t of b.turns) {
      console.log(`   turn=${t.turn} start=${t.startedAtMs} end=${t.endedAtMs} reason=${t.reasonKind} status=${t.status} steps=${t.steps?.length ?? 0}`);
    }
    // 打印与 turn 相关的原始记录
    const turnRecs = records.filter((r) => /^(turn|step)\//.test(String(r.type ?? '')));
    console.log(`turn/step 记录 ${turnRecs.length} 条:`);
    for (const r of turnRecs.slice(0, 12)) {
      console.log(`   ${r.type} ${JSON.stringify(r.data ?? r).slice(0, 220)}`);
    }
  }
}
