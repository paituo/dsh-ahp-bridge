/**
 * ★★★ 单测：agentMessage 的 item 生命周期补全（2026-10-16 血案修复）
 *
 * 血案：「发送后无任何消息返回」。根因 = 桥把 ACP `agent_message_chunk` 直接翻成
 *   `item/agentMessage/delta`，**既不带 itemId、也从不发 item/started**。
 *   官方 `mapAgentMessageDelta` 原文（codexMapAppServerEvents.ts）：
 *     const partId = state.itemToPartId.get(params.itemId);
 *     若无映射 → 官方注释 "Got a delta before we saw the corresponding
 *     item/started. Drop it" → **直接 return 空数组**
 *   ⇒ 无映射即**静默丢弃** ⇒ 界面永远空白。
 *
 * 本测试锁定修复后的**协议不变量**：
 *   ① 首块 agent_message_chunk ⇒ 必须产出 `item/started`，且 item.id 非空、
 *      item.type === "agentMessage"、item.text === 本块文本；
 *   ② 同 messageId 的第二块 ⇒ 必须产出 `item/agentMessage/delta`，且**带 itemId**
 *      （与 started 的 id 完全一致）；
 *   ③ 不同 messageId ⇒ 各自独立发 started（不复用映射）；
 *   ④ `seenAgentItems` 为空/缺失时 ⇒ 退化为「每次都发 started」（宁多建不丢字）；
 *   ⑤ 无 messageId 时应回退到 `msg-<turnId>` 合成 id（保证 itemId 永不为 undefined）。
 *
 * 跑法：node --test bridge/test/unit-agentmessage-item-lifecycle.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { translateSessionUpdate } from "../src/translate.mjs";

const TID = "turn-abc";
const SID = "sess-1";

/** 构造一条 ACP agent_message_chunk update */
const chunk = (text, messageId) => ({
  sessionId: SID,
  update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } },
});

test("① 首块 ⇒ item/started，item.id/type/text 正确", () => {
  const seen = new Set();
  const out = translateSessionUpdate(chunk("你好", "m1"), { turnId: TID, seenAgentItems: seen });
  assert.equal(out.length, 1);
  assert.equal(out[0].method, "item/started");
  assert.equal(out[0].params.item.id, "m1");
  assert.equal(out[0].params.item.type, "agentMessage");
  assert.equal(out[0].params.item.text, "你好");
  assert.equal(out[0].params.turnId, TID);
  assert.equal(out[0].params.threadId, SID);
  assert.ok(seen.has("m1"), "首块后应登记 messageId");
});

test("①b 契约：item/started 必须带 startedAtMs，且 item 含全部 required 字段", () => {
  const seen = new Set();
  const [n] = translateSessionUpdate(chunk("hi", "m1"), { turnId: TID, seenAgentItems: seen });
  // 官方 proto：ItemStartedNotification = { item, threadId, turnId, startedAtMs }
  assert.equal(typeof n.params.startedAtMs, "number", "缺 startedAtMs ⇒ serde 可能拒收");
  const it = n.params.item;
  // 官方 proto：agentMessage required = { type, id, text }，其余为 nullable
  assert.equal(it.type, "agentMessage");
  assert.ok(it.id);
  assert.equal(typeof it.text, "string");
  for (const k of ["phase", "memoryCitation", "delivery", "questions"]) {
    assert.ok(k in it, `item 应显式带 ${k}（可空项也要给全）`);
  }
});

test("② 同 messageId 第二块 ⇒ delta 且带 itemId（与 started 一致）", () => {
  const seen = new Set();
  const first = translateSessionUpdate(chunk("你好", "m1"), { turnId: TID, seenAgentItems: seen });
  const second = translateSessionUpdate(chunk("世界", "m1"), { turnId: TID, seenAgentItems: seen });
  const startedId = first[0].params.item.id;
  assert.equal(second.length, 1);
  assert.equal(second[0].method, "item/agentMessage/delta");
  assert.equal(second[0].params.itemId, startedId, "delta.itemId 必须等于 started.item.id");
  assert.equal(second[0].params.delta, "世界");
  assert.equal(second[0].params.turnId, TID);
});

test("③ 不同 messageId ⇒ 各自发 started（独立 item）", () => {
  const seen = new Set();
  translateSessionUpdate(chunk("A", "m1"), { turnId: TID, seenAgentItems: seen });
  const b = translateSessionUpdate(chunk("B", "m2"), { turnId: TID, seenAgentItems: seen });
  assert.equal(b[0].method, "item/started", "新 messageId 必须重新 started");
  assert.equal(b[0].params.item.id, "m2");
  assert.ok(seen.has("m1") && seen.has("m2"));
});

test("④ 缺 seenAgentItems ⇒ 退化为每次 started（宁多建不丢字）", () => {
  const a = translateSessionUpdate(chunk("x", "m1"), { turnId: TID });
  const b = translateSessionUpdate(chunk("y", "m1"), { turnId: TID });
  assert.equal(a[0].method, "item/started");
  assert.equal(b[0].method, "item/started", "无去重集时不得静默丢字");
});

test("⑤ 无 messageId ⇒ 回退 msg-<turnId>，itemId 永不为 undefined", () => {
  const seen = new Set();
  const out = translateSessionUpdate(chunk("z", undefined), { turnId: TID, seenAgentItems: seen });
  assert.equal(out[0].method, "item/started");
  assert.equal(out[0].params.item.id, `msg-${TID}`);
  assert.notEqual(out[0].params.item.id, undefined);
});

test("⑥ 契约关键：**任何** delta 输出都必须带非空 itemId", () => {
  const seen = new Set();
  const outs = [
    translateSessionUpdate(chunk("1", "m1"), { turnId: TID, seenAgentItems: seen }),
    translateSessionUpdate(chunk("2", "m1"), { turnId: TID, seenAgentItems: seen }),
    translateSessionUpdate(chunk("3", "m2"), { turnId: TID, seenAgentItems: seen }),
    translateSessionUpdate(chunk("4", "m2"), { turnId: TID, seenAgentItems: seen }),
  ].flat();
  const deltas = outs.filter((o) => o.method === "item/agentMessage/delta");
  assert.ok(deltas.length >= 2, "应至少有 2 条 delta");
  for (const d of deltas) {
    assert.ok(d.params.itemId, `delta 缺 itemId ⇒ 会被官方渲染层静默丢弃: ${JSON.stringify(d)}`);
  }
  // started 与后续 delta 的 id 必须能对上（成对闭合）
  const startedIds = new Set(outs.filter((o) => o.method === "item/started").map((o) => o.params.item.id));
  for (const d of deltas) assert.ok(startedIds.has(d.params.itemId), "delta.itemId 必须来自某个 started");
});
