import { transcriptEventsToTurns, toCodexThread, threadReadResult } from '../src/translate.mjs';
import { readTranscript, extractConversationEvents } from '../src/transcript.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  OK   ' + msg); } else { fail++; console.log('  FAIL ' + msg); } };

// ============ ① 事件 → Turn 配对语义 ============
console.log('\n[① 事件配对]');
/**
 * ★ 2026-10-17 夹具修正：原夹具是「user 无号 + assistant 有号」的混合。
 *   新分组逻辑（按轮次号分组）会**跳过无号事件**（它们无法归属到任何已知轮次）⇒
 *   u1/u2 被跳过 ⇒ 每组只剩 assistant。真实数据里 user 的号由
 *   `transcript.mjs::tagEventsWithTurn` 按 seq 区间补齐（生产路径 bridge.mjs 必调），
 *   所以此处的正确夹具应是**全有号**（模拟打标后的形态）。混合无号的边界行为
 *   单独在 ①b 里断言。
 */
const events = [
  { kind: 'user', id: 'u1', text: 'hi', turn: 1, timeMs: 1792160992852, seq: 1 },
  { kind: 'assistant', id: 'a1', text: '你好', turn: 1, timeMs: 1792160996826, seq: 2 },
  { kind: 'user', id: 'u2', text: '第二问', turn: 2, timeMs: 1792161000000, seq: 3 },
  { kind: 'assistant', id: 'a2', text: '第二答', turn: 2, timeMs: 1792161005000, seq: 4 },
];
const turns = transcriptEventsToTurns(events, { threadId: 'abc12345-def' });
ok(turns.length === 2, `配对出 ${turns.length} 个 turn（期望 2）`);
ok(turns[0].items.length === 2, `turn1 items=${turns[0].items.length}（期望 2）`);
ok(turns[0].items[0].type === 'userMessage', 'turn1[0].type = userMessage');
ok(turns[0].items[1].type === 'agentMessage', 'turn1[1].type = agentMessage');
ok(turns[0].status === 'completed', 'turn1.status = completed');
ok(turns[0].itemsView === 'full', 'turn1.itemsView = full');
ok(turns[0].error === null, 'turn1.error = null');

// ①b ★ 混合无号：无号事件被跳过（归属不了任何轮次）；仅剩有号的 assistant 成组
const mixed = transcriptEventsToTurns([
  { kind: 'user', id: 'u1', text: 'hi', turn: null, timeMs: 1792160992852, seq: 1 },
  { kind: 'assistant', id: 'a1', text: '你好', turn: 2, timeMs: 1792160996826, seq: 2 },
], { threadId: 't' });
ok(mixed.length === 1, `[user(无号),assistant(2)] ⇒ ${mixed.length} turn（期望 1，无号被跳过）`);
ok(mixed[0].items.length === 1 && mixed[0].items[0].type === 'agentMessage',
  '无号 user 不产出 item（归属不可知 ⇒ 宁可不上屏）');

// ★ 官方 required（proto-v2-Turn.ts）：id, items, itemsView, status, error, startedAt, completedAt, durationMs
const REQUIRED = ['id', 'items', 'itemsView', 'status', 'error', 'startedAt', 'completedAt', 'durationMs'];
for (const t of turns) {
  const missing = REQUIRED.filter(k => !(k in t));
  ok(missing.length === 0, `turn "${t.id}" 含全部 8 个 required${missing.length ? '（缺 ' + missing + '）' : ''}`);
}

// ★ UserInput.text 契约：{type,text,text_elements}
const ui = turns[0].items[0].content[0];
ok(ui.type === 'text' && typeof ui.text === 'string' && Array.isArray(ui.text_elements),
  'UserInput = {type:"text", text, text_elements:[]}');

// ★ TurnStatus 枚举合法性
const VALID_STATUS = ['completed', 'failed', 'inProgress', 'interrupted'];
ok(VALID_STATUS.includes(turns[0].status), `status "${turns[0].status}" 在官方枚举内`);
const VALID_VIEW = ['full', 'notLoaded', 'summary'];
ok(VALID_VIEW.includes(turns[0].itemsView), `itemsView "${turns[0].itemsView}" 在官方枚举内`);

// ★ 时间戳单位 = 秒（官方 "Unix timestamp (in seconds)"）
ok(turns[0].startedAt === 1792160992, `startedAt=${turns[0].startedAt} 已归一到秒`);
ok(typeof turns[0].durationMs === 'number', `durationMs=${turns[0].durationMs} 为毫秒数字`);

// ============ ② 边界：只有 user 无 assistant ============
console.log('\n[② 悬挂 turn]');
// 最后一条悬挂 ⇒ inProgress（可能与实时轮次重合）
const dangling = transcriptEventsToTurns([{ kind: 'user', id: 'u', text: 'x', timeMs: 1792160992852, seq: 1 }], { threadId: 't' });
ok(dangling.length === 1 && dangling[0].status === 'inProgress', '仅 user 且为最后一条 ⇒ status=inProgress');
ok(dangling[0].items.length === 1, '仅 user ⇒ items 只有 1 项');
// 非最后一条悬挂 ⇒ interrupted（历史已终结，不应显示"进行中"）
const mid = transcriptEventsToTurns([
  { kind: 'user', id: 'u1', text: 'a', timeMs: 1792160992852, seq: 1 },
  { kind: 'user', id: 'u2', text: 'b', timeMs: 1792160993852, seq: 2 },
  { kind: 'assistant', id: 'a2', text: 'ok', timeMs: 1792160996852, seq: 3 },
], { threadId: 't' });
// 分组：(u1) / (u2+a2) ⇒ 2 组；u1 悬挂且非最后 ⇒ interrupted
ok(mid.length === 2, `[u,u,a] 配对出 ${mid.length} turn（期望 2）`);
ok(mid[0].status === 'interrupted', `中间悬挂 ⇒ status=${mid[0].status}（期望 interrupted）`);
ok(mid[1].status === 'completed', `末条有答 ⇒ status=${mid[1].status}（期望 completed）`);

// ============ ③ 空输入 ============
console.log('\n[③ 空输入]');
ok(transcriptEventsToTurns([], {}).length === 0, '空事件 → 空数组');
ok(transcriptEventsToTurns(null, {}).length === 0, 'null → 空数组');

// ============ ④ historyMode 必须是合法枚举 ============
console.log('\n[④ historyMode 枚举]');
const th = toCodexThread('tid', { turns });
ok(['legacy', 'paginated'].includes(th.historyMode), `historyMode="${th.historyMode}" 合法（官方仅 legacy|paginated）`);
ok(Array.isArray(th.turns) && th.turns.length === 2, 'thread.turns 已带入');

// ============ ⑤ 端到端：真实转录 → turns ============
console.log('\n[⑤ 真实转录端到端]');
const { records } = await readTranscript('8b2ba05a-c8ef-477a-8ad4-1d9287920408', 'E:/分析数据/DeepSeek-Harness-VSCode/dev');
const { events: ev } = extractConversationEvents(records);
const realTurns = transcriptEventsToTurns(ev, { threadId: '8b2ba05a' });
ok(realTurns.length > 0, `真实转录 → ${realTurns.length} turn（事件 ${ev.length} 条）`);
const rr = threadReadResult('8b2ba05a', { turns: realTurns, cwd: 'E:/x' });
ok(rr.thread && Array.isArray(rr.thread.turns) && rr.thread.turns.length === realTurns.length,
  'threadReadResult 正确包裹 turns（thread.turns）');

console.log(`\n=== 通过 ${pass} / 失败 ${fail} ===`);
process.exit(fail ? 1 : 0);
