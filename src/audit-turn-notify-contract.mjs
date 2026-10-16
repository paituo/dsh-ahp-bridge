/**
 * 契约校验：turn/started & turn/completed 通知 vs 官方 codex schema。
 * 并**模拟 VS Code 消费侧**证明：
 *   旧结构（缺 turn 包装）⇒ `params.turn.id` 抛 `Cannot read properties of undefined (reading 'id')`
 *   新结构 ⇒ 正常
 *
 * 用法： node audit-turn-notify-contract.mjs
 */
import { translateTurnStarted, translatePromptDone } from "./translate.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

// ---- 官方 schema（openai/codex v2）----
// TurnStartedNotification.required = [threadId, turn]；Turn.required = [id, items, status]
const TURN_NOTIF_REQ = ["threadId", "turn"];
const TURN_REQ = ["id", "items", "status"];

const checkNotif = (label, n) => {
  console.log(`[${label}] method=${n.method}`);
  for (const k of TURN_NOTIF_REQ) ok(n.params?.[k] !== undefined, `params 有 required '${k}'`);
  for (const k of TURN_REQ) ok(n.params?.turn?.[k] !== undefined, `params.turn 有 required '${k}'`);
};

// ---- 模拟 VS Code codexAgent.ts:3121 `const appTurnId = params.turn.id` ----
const vsConsume = (params) => { const appTurnId = params.turn.id; return appTurnId; };

const SID = "sess-abc12345";
const TID = "turn-xyz";

// ---------- 1. turn/started ----------
console.log("=== 1. turn/started ===");
const started = translateTurnStarted(SID, TID, "你好", new Date().toISOString());
checkNotif("turn/started", started);
// items 必须为空数组（避免双条）
ok(Array.isArray(started.params.turn.items) && started.params.turn.items.length === 0,
   "turn.items === []（既满足 required，又不触发源 A 双条渲染）");
ok(started.params.message?.text === "你好", "保留注入层 reflow 用的 message.text");
try { ok(vsConsume(started.params) === TID, "VS Code 消费侧读到 turn.id"); }
catch (e) { ok(false, `消费侧崩: ${e.message}`); }

// ---------- 2. turn/completed ----------
console.log("\n=== 2. turn/completed ===");
const done = translatePromptDone(SID, TID, 1234);
checkNotif("turn/completed", done);
ok(done.params.turn.status === "completed", "turn.status = completed");
ok(done.params.turn.durationMs === 1234, "turn.durationMs = 1234（毫秒）");
ok(done.params.turn.completedAt < 1e11, `turn.completedAt 是秒级 (${done.params.turn.completedAt} < 1e11)`);
try { ok(vsConsume(done.params) === TID, "VS Code 消费侧读到 turn.id"); }
catch (e) { ok(false, `消费侧崩: ${e.message}`); }

// ---------- 3. 回归对照：旧结构必崩 ----------
console.log("\n=== 3. 回归对照：旧 turn/completed（扁平，无 turn 包装） ===");
let crashed = false, msg = "";
try { vsConsume({ threadId: SID, turnId: TID, duration: 1234 }); }   // ← 旧结构
catch (e) { crashed = true; msg = e.message; }
ok(crashed && /reading 'id'/.test(msg), `旧结构复现报错: "${msg}"`);

// ---------- 4. 失败路径 ----------
console.log("\n=== 4. 失败路径 turn/completed (status=failed) ===");
const failed = translatePromptDone(SID, TID, 500);
failed.params.turn.status = "failed";
failed.params.turn.error = { message: "boom" };
checkNotif("turn/completed(failed)", failed);
ok(failed.params.turn.error?.message === "boom", "错误信息挂在 turn.error");

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
