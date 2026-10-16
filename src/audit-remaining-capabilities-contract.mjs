/**
 * 契约校验：剩余能力通知 vs 官方 codex schema（2026-10-17 补齐）
 *
 * 覆盖三处**此前违规或缺失**的通知：
 *   ① `thread/tokenUsage/updated` —— 官方 `ThreadTokenUsageUpdatedNotification`
 *   ② `item/started`(reasoning) / `item/completed`(reasoning) —— 思考 item 生命周期
 *   ③ `usage_update`（ACP 侧）→ 上面 ① 的映射
 *
 * 并**模拟 VS Code 消费侧**证明旧结构必崩、新结构正常。
 *
 * 用法： node audit-remaining-capabilities-contract.mjs
 * 契约真源：../dev/codex-protocol-schema/*.json（已落盘的 openai/codex 官方导出）
 */
import { translateTokenUsage, translateUsageUpdate, translateSessionUpdate } from "./translate.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

// ---- 官方 schema（openai/codex 0.157.0，见 codex-protocol-schema/）----
const NOTIF_REQ = ["threadId", "tokenUsage", "turnId"];
const TU_REQ = ["last", "total"];
const BK_REQ = ["cachedInputTokens", "inputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];
const RZ_ITEM_REQ = ["id", "type"];

// ---------- 1. thread/tokenUsage/updated（DSH usage 外层形态）----------
console.log("=== 1. thread/tokenUsage/updated（translateTokenUsage）===");
const u = translateTokenUsage("sess-1", "turn-1", { inputTokens: 100, outputTokens: 50, cachedInputTokens: 20, reasoningOutputTokens: 10 }, { modelContextWindow: 128000 });
for (const k of NOTIF_REQ) ok(u.params[k] !== undefined, `params 有 required '${k}'`);
for (const k of TU_REQ) ok(u.params.tokenUsage[k] !== undefined, `tokenUsage 有 required '${k}'`);
for (const k of BK_REQ) ok(u.params.tokenUsage.last[k] !== undefined, `last 有 required '${k}'`);
ok(u.params.tokenUsage.modelContextWindow === 128000, "modelContextWindow 透传");
ok(u.params.tokenUsage.last.totalTokens === 180, `totalTokens = 100+50+20+10 = 180（实得 ${u.params.tokenUsage.last.totalTokens}）`);

// ---------- 2. usage_update（ACP）→ 同一通知 ----------
console.log("\n=== 2. usage_update（ACP 侧）→ thread/tokenUsage/updated ===");
const uu = translateUsageUpdate("sess-1", "turn-1", { used: 45678, size: 200000 });
for (const k of NOTIF_REQ) ok(uu.params[k] !== undefined, `params 有 required '${k}'`);
for (const k of TU_REQ) ok(uu.params.tokenUsage[k] !== undefined, `tokenUsage 有 required '${k}'`);
ok(uu.params.tokenUsage.modelContextWindow === 200000, "size → modelContextWindow");
ok(uu.params.tokenUsage.last.totalTokens === 45678, "used → last.totalTokens");

// 经 translateSessionUpdate 端到端（证明不再落 default）
console.log("  [经 translateSessionUpdate 端到端]");
const viaUpdate = translateSessionUpdate({ sessionId: "sess-1", update: { sessionUpdate: "usage_update", used: 1, size: 2 } }, { turnId: "t" });
ok(viaUpdate.length === 1 && viaUpdate[0].method === "thread/tokenUsage/updated", `kind=usage_update → ${viaUpdate[0]?.method}`);
ok(!viaUpdate.some(n => n.params?.item?.type === "unknown"), "★ 不再产出 type:\"unknown\" 垃圾 item");

// ---------- 3. reasoning item 生命周期 ----------
console.log("\n=== 3. reasoning（思考）item 生命周期 ===");
const seen = new Set();
const ctx = { turnId: "turn-1", seenReasoningItems: seen };
const st = translateSessionUpdate({ sessionId: "sess-1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "思考中" } } }, ctx);
const dl = translateSessionUpdate({ sessionId: "sess-1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "…" } } }, ctx);
ok(st[0].method === "item/started", `首条 → ${st[0].method}（先建 itemToPartId 映射）`);
for (const k of RZ_ITEM_REQ) ok(st[0].params.item[k] !== undefined, `reasoning item 有 required '${k}'`);
ok(st[0].params.item.type === "reasoning", 'item.type = "reasoning"');
ok(st[0].params.startedAtMs !== undefined, "带 startedAtMs（ItemStartedNotification required）");
ok(dl[0].method === "item/reasoning/textDelta" && dl[0].params.itemId === st[0].params.item.id, "后续 delta 与 started 同 itemId");

// ---------- 4. 回归对照：旧结构必崩 ----------
console.log("\n=== 4. 回归对照：旧 tokenUsage（只有 last、无 total）===");
const old = { threadId: "s", turnId: "t", tokenUsage: { last: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0, reasoningOutputTokens: 0 } } };
let crashed = false, msg = "";
try { const _x = old.tokenUsage.total.inputTokens; } catch (e) { crashed = true; msg = e.message; }
ok(crashed && /reading 'inputTokens'/.test(msg), `旧结构复现: "${msg}"`);

console.log("\n=== 5. 回归对照：旧 reasoning（只发 delta、无 started）===");
// 模拟 renderer：无 itemToPartId 映射时 delta 被丢弃
const partMap = new Map();
const rendererAccepts = (n) => {
  if (n.method === "item/started" && n.params.item.type === "reasoning") { partMap.set(n.params.item.id, "part"); return "render"; }
  if (n.method === "item/reasoning/textDelta") { return partMap.has(n.params.itemId) ? "append" : "DROP（无映射）"; }
  return "?";
};
ok(rendererAccepts({ method: "item/reasoning/textDelta", params: { itemId: "think-x" } }) === "DROP（无映射）", "旧行为：裸 delta 被丢弃");
ok(rendererAccepts(st[0]) === "render" && rendererAccepts(dl[0]) === "append", "新行为：started 后 delta 正确 append");

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
