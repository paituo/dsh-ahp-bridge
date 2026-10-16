/**
 * 单测：剩余能力补齐（2026-10-17）
 *   ① usage_update 通道（此前落 default ⇒ 发 type:"unknown" 垃圾 item）
 *   ② thread/tokenUsage/updated 契约（官方 schema：total 是 required，5 个分项都要）
 *   ③ reasoning（思考）item 生命周期（先 started 再 delta）
 *   ④ turnBoundary 权威边界（turn/end.reason.kind → TurnStatus 映射）
 *
 * 契约真源：dev/codex-protocol-schema/ 下已落盘的官方 schema
 *   · ThreadTokenUsageUpdatedNotification.json  required=["threadId","tokenUsage","turnId"]
 *     ThreadTokenUsage required=["last","total"]；TokenUsageBreakdown required=5 项含 totalTokens
 *   · ItemStartedNotification.json  ThreadItem.reasoning required=["id","type"]
 */
import { translateSessionUpdate, translateTokenUsage, translateUsageUpdate, transcriptEventsToTurns } from '../src/translate.mjs';
import { extractTurnBoundaries, turnEndReasonToStatus } from '../src/transcript.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK   ' + m); } else { fail++; console.log('  FAIL ' + m); } };

// ============ ① usage_update 通道 ============
console.log('\n[① usage_update 不再落 default]');
const upd = translateSessionUpdate(
  { sessionId: 's1', update: { sessionUpdate: 'usage_update', used: 12345, size: 200000 } },
  { turnId: 't1' },
);
ok(upd.length === 1, `产出 ${upd.length} 条（期望 1）`);
ok(upd[0].method === 'thread/tokenUsage/updated', `method=${upd[0].method}`);
ok(upd.every(n => !(n.params?.item?.type === 'unknown')),
  '★ 不再产生 item/started type:"unknown" 垃圾 item');
ok(upd[0].params.tokenUsage.modelContextWindow === 200000, 'modelContextWindow = size(200000)');
ok(upd[0].params.tokenUsage.last.totalTokens === 12345, 'last.totalTokens = used(12345)');

// ============ ② tokenUsage 官方契约 ============
console.log('\n[② thread/tokenUsage/updated 契约]');
const NOTIF_REQ = ['threadId', 'tokenUsage', 'turnId'];
const TU_REQ = ['last', 'total'];
const BK_REQ = ['cachedInputTokens', 'inputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
for (const k of NOTIF_REQ) ok(upd[0].params[k] !== undefined, `params 有 required '${k}'`);
for (const k of TU_REQ) ok(upd[0].params.tokenUsage[k] !== undefined, `tokenUsage 有 required '${k}'`);
for (const k of BK_REQ) ok(upd[0].params.tokenUsage.last[k] !== undefined, `last 有 required '${k}'`);

// 回归对照：旧结构（只有 last、无 total）⇒ vs 消费侧读 total 必崩
const oldShape = { threadId: 's', turnId: 't', tokenUsage: { last: { inputTokens: 1 } } };
let crashed = false, msg = '';
try { const _ = oldShape.tokenUsage.total.inputTokens; } catch (e) { crashed = true; msg = e.message; }
ok(crashed && /reading 'inputTokens'/.test(msg), `旧结构复现崩溃: "${msg}"`);

// 分项带 snake_case 也要认
const u2 = translateTokenUsage('s', 't', { input_tokens: 10, output_tokens: 20, cached_input_tokens: 5, reasoning_output_tokens: 3 });
ok(u2.params.tokenUsage.last.inputTokens === 10 && u2.params.tokenUsage.last.outputTokens === 20, 'snake_case 输入识别');
ok(u2.params.tokenUsage.last.totalTokens === 38, `totalTokens 由四项求和 = 38（实得 ${u2.params.tokenUsage.last.totalTokens}）`);
ok(u2.params.tokenUsage.total !== undefined, '★ total 是 required：已补上（回落 last）');

// ============ ③ reasoning item 生命周期 ============
console.log('\n[③ reasoning（思考）item 生命周期]');
const seen = new Set();
const ctx = { turnId: 't-9', seenReasoningItems: seen };
const r1 = translateSessionUpdate({ sessionId: 's1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '先想一想' } } }, ctx);
const r2 = translateSessionUpdate({ sessionId: 's1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '再想想' } } }, ctx);
ok(r1.length === 1 && r1[0].method === 'item/started', `首条 → item/started（实得 ${r1[0]?.method}）`);
ok(r1[0].params.item.type === 'reasoning', 'item.type = reasoning');
ok(r1[0].params.item.id === 'think-t-9', `item.id 由 turnId 派生 = think-t-9（实得 ${r1[0].params.item.id}）`);
ok('content' in r1[0].params.item && r1[0].params.item.content === '先想一想', '★ 文本走 content（非 text）——schema 实证');
ok(r1[0].params.startedAtMs !== undefined, '带 startedAtMs（ItemStartedNotification required）');
ok(r2.length === 1 && r2[0].method === 'item/reasoning/textDelta', `第二条 → reasoning/textDelta（实得 ${r2[0]?.method}）`);
ok(r2[0].params.itemId === 'think-t-9', 'delta 带 itemId（renderer 靠它找 part）');
ok(seen.size === 1, `seen 集合只含 1 个 id（实得 ${seen.size}）`);

// 契约：reasoning required 只有 id/type
const RZ_REQ = ['id', 'type'];
ok(RZ_REQ.every(k => r1[0].params.item[k] !== undefined), 'reasoning item 含 required id/type');

// ★ 关键回归：新旧两轮必须分别发 started（seenReasoningItems 需被重置）
const seen2 = new Set();
translateSessionUpdate({ sessionId: 's1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'A' } } }, { turnId: 't-9', seenReasoningItems: seen2 });
seen2.clear();   // ← 模拟 turn/start 的重置
const r3 = translateSessionUpdate({ sessionId: 's1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'B' } } }, { turnId: 't-10', seenReasoningItems: seen2 });
ok(r3[0].method === 'item/started', '★ 重置后新一轮仍发 started（否则 delta 被静默丢弃）');

// agentMessage 与 reasoning 必须用**各自独立**的 Set（id 空间不互污）
const seenA = new Set();
const am = translateSessionUpdate({ sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm-1', content: { type: 'text', text: 'hi' } } }, { turnId: 't', seenAgentItems: seenA });
ok(am[0].method === 'item/started' && seenA.has('m-1'), 'agentMessage 用 seenAgentItems（与 reasoning 分离）');

// ============ ④ turnBoundary 权威边界 ============
console.log('\n[④ turnBoundary 权威边界]');
const recs = [
  { type: 'turn/start', seq: 4, time: 1000, data: { turn: 1 } },
  { type: 'step/start', seq: 6, time: 1100, data: { turn: 1, step: 1 } },
  { type: 'step/end', seq: 19, time: 1200, data: { turn: 1, step: 1 } },
  { type: 'turn/end', seq: 24, time: 1300, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 26, time: 2000, data: { turn: 2 } },
  { type: 'step/start', seq: 28, time: 2100, data: { turn: 2, step: 1 } },
  { type: 'turn/end', seq: 40, time: 2200, data: { turn: 2, reason: { kind: 'error' } } },
  { type: 'turn/start', seq: 42, time: 3000, data: { turn: 3 } },   // 开放轮（无 end）
];
const b = extractTurnBoundaries(recs);
ok(b.turns.length === 3, `提出 ${b.turns.length} 个轮次（期望 3）`);
ok(b.lastTurn === 3, `lastTurn=${b.lastTurn}`);
ok(b.openTurn === 3, `★ openTurn=${b.openTurn}（有 start 无 end ⇒ 确证的进行中）`);
ok(b.turns[0].status === 'completed', `turn1 status=${b.turns[0].status}`);
ok(b.turns[1].status === 'failed', `turn2 (error) status=${b.turns[1].status} — 真错才 failed`);
ok(b.turns[1].reasonKind === 'error', 'turn2 reasonKind 保留原值');
ok(b.turns[0].steps === 1, `turn1 steps=${b.turns[0].steps}`);
ok(b.lastStepBoundary?.turn === 2 && b.lastStepBoundary?.step === 1, 'lastStepBoundary 取到 turn2/step1');

// reason.kind → TurnStatus 映射全枚举
console.log('  [reason.kind → TurnStatus]');
const MAP = { completed: 'completed', error: 'failed', aborted: 'interrupted', interrupted: 'interrupted', 'max-tokens': 'interrupted', blocked: 'interrupted' };
for (const [k, v] of Object.entries(MAP)) {
  ok(turnEndReasonToStatus(k) === v, `  ${k.padEnd(12)} → ${turnEndReasonToStatus(k)}（期望 ${v}）`);
}
ok(turnEndReasonToStatus(undefined) === null, '★ 缺失 reason ⇒ null（中性回落，不猜）');
ok(turnEndReasonToStatus('某个未来新值') === null, '未知 reason ⇒ null（不硬套 failed）');

// 边界校正进入 Turn[]：状态来自 boundary 而非启发式
console.log('  [边界校正 Turn[]]');
/**
 * ★ 2026-10-17 夹具修正（血案驱动）：
 *   原夹具**无 turn 号**却期望"位置命中边界" —— 这正是被废除的行为（见 translate.mjs
 *   的"关键修正 ②"）。真实生产路径先 `tagEventsWithTurn` 补号（user 也有号），
 *   因此正确夹具是**全有号**（turn 1 / 1 / 2）。
 *   "无号 ⇒ 放弃边界校正"单独在 [无号放弃校正] 段断言。
 */
const evs = [
  { kind: 'user', id: 'u1', text: 'q1', turn: 1, timeMs: 1000, seq: 1 },
  { kind: 'assistant', id: 'a1', text: 'a1', turn: 1, timeMs: 1200, seq: 2 },
  { kind: 'user', id: 'u2', text: 'q2', turn: 2, timeMs: 2000, seq: 3 },
];
const turns = transcriptEventsToTurns(evs, { threadId: 'th', boundaries: b });
ok(turns.length === 2, `配对出 ${turns.length} 个 turn`);
ok(turns[0].status === 'completed', `turn1 status=${turns[0].status}（boundary 校正）`);
ok(/^boundary:/.test(turns[0].statusSource), `turn1 statusSource=${turns[0].statusSource}`);
// ★ 关键：u2 无 assistant（因 error 轮无答）——启发式会给 inProgress，
//   但边界显示 turn2 有 end(error) ⇒ 必须 failed
ok(turns[1].status === 'failed', `★ turn2 无 assistant 但有 turn/end(error) ⇒ ${turns[1].status}（启发式本会给 inProgress）`);
ok(turns[1].completedAt !== null, 'turn2 completedAt 非空（已终结）');

// ★ 2026-10-17 新增：**无号 + 有边界 ⇒ 放弃校正**（不拿位置猜，防虚构终态）
console.log('  [无号放弃校正]');
const noTurnEvs = [
  { kind: 'user', id: 'u1', text: 'q1', timeMs: 1000, seq: 1 },
  { kind: 'assistant', id: 'a1', text: 'a1', timeMs: 1200, seq: 2 },
  { kind: 'user', id: 'u2', text: 'q2', timeMs: 2000, seq: 3 },
];
const tNo = transcriptEventsToTurns(noTurnEvs, { threadId: 'th', boundaries: b });
ok(tNo.length === 2, `无号仍按顺序配对出 ${tNo.length} turn`);
ok(tNo.every((t) => t.statusSource === 'heuristic:no-turnno-with-boundaries'),
  `★ 无号+有边界 ⇒ statusSource=${tNo[0].statusSource}（明确标注放弃校正）`);
ok(tNo.every((t) => t.turnNo === null), '无号 ⇒ turnNo 保持 null（不臆造轮次号）');
// 无号时 turn2 不被隔壁轮的 failed 污染 ⇒ 走启发式 inProgress
ok(tNo[1].status === 'inProgress', `★ 无号时 turn2 status=${tNo[1].status}（启发式，未被边界虚构 failed 污染）`);

// 无 boundaries ⇒ 回落启发式（向后兼容）
//   ★ 2026-10-17：有号但**无边界表**时标注更精确 —— `heuristic:no-boundary`
//     （原来笼统 `heuristic`，无法区分"没给边界表"与"给了但查不到"）
const t2 = transcriptEventsToTurns(evs, { threadId: 'th' });
ok(/^heuristic/.test(t2[0].statusSource), `无 boundaries ⇒ statusSource=${t2[0].statusSource}（向后兼容）`);

// 官方 required 仍齐全
const REQUIRED = ['id', 'items', 'itemsView', 'status', 'error', 'startedAt', 'completedAt', 'durationMs'];
for (const t of turns) {
  const missing = REQUIRED.filter(k => !(k in t));
  ok(missing.length === 0, `turn "${t.id}" 含全部 8 个 required${missing.length ? '（缺 ' + missing + '）' : ''}`);
}
ok(turns.every(t => ['completed', 'failed', 'inProgress', 'interrupted'].includes(t.status)), '全部 status 在官方枚举内');

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
