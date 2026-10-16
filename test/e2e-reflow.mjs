/**
 * 事件回流（codex 通知 → chat action）离线单测。
 *
 * 验证 makeReflowTranslator 产出的 action 结构**与 bundle 实证的 chat/* 形态一致**：
 *   - 外层 {kind:"action", resource:<chatChannelUri>, action}
 *   - chat/turnStarted  含 turnId/startedAt/message{text,origin{kind:"user"}}
 *   - 首块文本 → chat/responsePart{part:{kind:"markdown",id,content}}；后续 → chat/delta{partId,content}
 *   - chat/turnComplete 含 turnId/duration
 *   - 无 resource 时不 fire（复刻 bundle drop 行为）
 */
import { makeReflowTranslator } from "../src/inject-translate.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  \u2713 ${m}`); } else { fail++; console.log(`  \u2717 ${m}`); } };

console.log("\n[1] resource 未登记时不 fire（复刻 bundle drop 行为）");
{
  const seen = [];
  const r = makeReflowTranslator({ fire: o => seen.push(o) });
  r.markdownDelta("t1", "hello");
  ok(seen.length === 0, "无 chatChannelUri ⇒ 不 fire");
}

console.log("\n[2] turnStarted + 首块/后续文本（markdown part 语义）");
{
  const seen = [];
  const r = makeReflowTranslator({ fire: o => seen.push(o) });
  r.beginChat("file:///c%3A/proj%23chat", "t1");
  r.onNotify("turn/started", { threadId: "t1", message: { text: "你好" } });
  r.onNotify("item/agentMessage/delta", { threadId: "t1", delta: "收" });
  r.onNotify("item/agentMessage/delta", { threadId: "t1", delta: "到" });
  r.onNotify("turn/completed", { threadId: "t1", duration: 1234 });

  ok(seen.length === 4, `4 条 action（实际 ${seen.length}）`);
  const [a0, a1, a2, a3] = seen;
  ok(a0.kind === "action" && a0.resource === "file:///c%3A/proj%23chat", "外层 resource = chatChannelUri");
  ok(a0.action.type === "chat/turnStarted", "第1条 = chat/turnStarted");
  ok(a0.action.message?.text === "你好" && a0.action.message?.origin?.kind === "user", "message.text/origin 正确");
  ok(a1.action.type === "chat/responsePart" && a1.action.part?.kind === "markdown" && a1.action.part?.content === "收",
     "首块 = chat/responsePart{markdown,content=收}");
  const partId = a1.action.part.id;
  ok(a2.action.type === "chat/delta" && a2.action.partId === partId && a2.action.content === "到",
     "后续 = chat/delta{partId 同前, content=到}");
  ok(a3.action.type === "chat/turnComplete" && a3.action.duration === 1234, "末条 = chat/turnComplete{duration}");
}

console.log("\n[3] reasoning 分流（不混进 markdown part）");
{
  const seen = [];
  const r = makeReflowTranslator({ fire: o => seen.push(o) });
  r.beginChat("u1", "t2");
  r.onNotify("turn/started", { threadId: "t2", message: { text: "问" } });
  r.onNotify("item/reasoning/delta", { threadId: "t2", delta: "思考1" });
  r.onNotify("item/reasoning/delta", { threadId: "t2", delta: "思考2" });
  r.onNotify("item/agentMessage/delta", { threadId: "t2", delta: "正文" });
  ok(seen[1].action.type === "chat/responsePart" && seen[1].action.part.kind === "reasoning", "reasoning 首块建 reasoning part");
  ok(seen[2].action.type === "chat/reasoning", "reasoning 后续 = chat/reasoning");
  ok(seen[3].action.type === "chat/responsePart" && seen[3].action.part.kind === "markdown", "正文另起 markdown part");
  ok(seen[0].action.turnId === seen[3].action.turnId, "同一轮内 turnId 一致");
}

console.log("\n[4] 错误路径 → chat/error");
{
  const seen = [];
  const r = makeReflowTranslator({ fire: o => seen.push(o) });
  r.beginChat("u2", "t3");
  r.onNotify("turn/started", { threadId: "t3" });
  r.onNotify("turn/error", { threadId: "t3", message: "Authentication Fails" });
  ok(seen[1].action.type === "chat/error", "错误 → chat/error");
  // ★ 契约已升级（2026-10-11 v4）：error part 由旧形态 {kind:"systemNotification", content:{markdown}}
  //   改为标准形态 {kind:"error", error:{message, errorType}}。断言必须同步，否则是"测试过期"而非实现回归。
  const ep = seen[1].action.part;
  ok(ep?.kind === "error" && /Authentication Fails/.test(String(ep?.error?.message ?? "")), "错误信息保留（part.error.message）");
  // 序列化回归：JSON 往返后 message 必须仍在（Error 实例的 message 不可枚举会丢，这是 v4 血案）
  const rt = JSON.parse(JSON.stringify(ep));
  ok(typeof rt?.error?.message === "string" && rt.error.message.length > 0 && rt.error.errorType, "错误可序列化（message+errorType 非空）");
}

console.log("\n[5] 未映射通知不产生噪声");
{
  const seen = [];
  const r = makeReflowTranslator({ fire: o => seen.push(o) });
  r.beginChat("u3", "t4");
  r.onNotify("account/updated", { threadId: "t4" });
  r.onNotify("skills/changed", { threadId: "t4" });
  ok(seen.length === 0, "无关通知不 fire");
}

console.log("\n[6] 多 chat 隔离（各自 resource / partId）");
{
  const seen = [];
  const r = makeReflowTranslator({ fire: o => seen.push(o) });
  r.beginChat("chatA", "a"); r.beginChat("chatB", "b");
  r.onNotify("turn/started", { threadId: "a" });
  r.onNotify("turn/started", { threadId: "b" });
  r.markdownDelta("a", "A1"); r.markdownDelta("b", "B1"); r.markdownDelta("a", "A2");
  ok(seen[2].resource === "chatA" && seen[3].resource === "chatB", "resource 各自独立");
  ok(seen[2].action.part.id !== seen[3].action.part.id, "partId 不串");
  ok(seen[4].action.type === "chat/delta" && seen[4].resource === "chatA", "A 的后续 delta 仍归 A");
}

console.log("\n[7] 自动开轮（未收到 turn/started 也能工作）");
{
  const seen = [];
  const r = makeReflowTranslator({ fire: o => seen.push(o) });
  r.beginChat("u4", "t5");
  r.onNotify("item/agentMessage/delta", { threadId: "t5", delta: "hi" });
  ok(seen[0].action.type === "chat/turnStarted", "缺 turn/started 时自动补");
  ok(seen[1].action.type === "chat/responsePart", "随后建 markdown part");}

// ★★★ 以下为 T1~T4 新增用例（2026-10-11）
console.log("\n[8] T2：turnId 以桥下发的 turn.id 为唯一真源（三方归一）");
{
  const seen = [];
  const r = makeReflowTranslator({ fire: o => seen.push(o) });
  r.beginChat("u5", "t6");
  // 桥的 turn/started 带 turn.id（真源）
  r.onNotify("turn/started", { threadId: "t6", turn: { id: "TURN-HOST-1" }, message: { text: "问" } });
  r.onNotify("item/agentMessage/delta", { threadId: "t6", turnId: "TURN-HOST-1", delta: "答" });
  r.onNotify("turn/completed", { threadId: "t6", turnId: "TURN-HOST-1", duration: 10 });
  ok(seen[0].action.turnId === "TURN-HOST-1", "turnStarted 用桥下发的 turn.id 作 turnId");
  ok(seen[1].action.turnId === "TURN-HOST-1", "后续 item 通知的 turnId 与 activeTurn 一致");
  ok(seen[2].action.turnId === "TURN-HOST-1", "收尾 turnComplete 的 turnId 一致（否则 renderer 不收尾）");
}

console.log("\n[9] T1：工具调用五段式结构化（Start→Ready→ContentChanged→Complete）");
{
  const seen = [];
  const r = makeReflowTranslator({ fire: o => seen.push(o) });
  r.beginChat("u6", "t7");
  r.onNotify("turn/started", { threadId: "t7", turn: { id: "T7TURN" } });
  r.onNotify("item/started", { threadId: "t7", turnId: "T7TURN", item: { type: "toolCall", toolCallId: "tc1", toolName: "pwsh", displayName: "运行命令", status: "in_progress", rawInput: { command: "echo hi" } } });
  r.onNotify("item/completed", { threadId: "t7", turnId: "T7TURN", item: { type: "toolCall", toolCallId: "tc1", status: "completed", content: [{ type: "content", content: { type: "text", text: "hi" } }] } });
  r.onNotify("turn/completed", { threadId: "t7", turnId: "T7TURN", duration: 5 });
  const types = seen.map(e => e.action.type);
  ok(types[1] === "chat/toolCallStart", "item/started(toolCall) → chat/toolCallStart");
  const start = seen[1].action;
  ok(start.turnId === "T7TURN" && start.toolCallId === "tc1" && start.toolName === "pwsh" && start.displayName === "运行命令",
     "toolCallStart 带 turnId/toolCallId/toolName/displayName（renderer 契约）");
  ok(seen[2].action.type === "chat/toolCallDelta" && seen[2].action.content.includes("echo"),
     "初始 rawInput → chat/toolCallDelta（partialInput）");
  ok(types.includes("chat/toolCallReady"), "完成前先发 chat/toolCallReady（streaming→running）");
  ok(types.includes("chat/toolCallContentChanged"), "工具输出 → chat/toolCallContentChanged");
  ok(types.includes("chat/toolCallComplete"), "工具完成 → chat/toolCallComplete");
  // 顺序铁律
  const ri = types.indexOf("chat/toolCallReady"), ci = types.indexOf("chat/toolCallContentChanged"), xi = types.indexOf("chat/toolCallComplete");
  ok(ri < ci && ci < xi, "顺序正确：Ready < ContentChanged < Complete（ContentChanged 要求 running）");
  // Complete 必须在 turnComplete 之前（否则 PIo 会把它标 cancelled）
  ok(xi < types.lastIndexOf("chat/turnComplete"), "toolCallComplete 早于 turnComplete（避免被标 cancelled）");
}

console.log("\n[10] T3：reasoning 走专用通道 item/reasoning/textDelta");
{
  const seen = [];
  const r = makeReflowTranslator({ fire: o => seen.push(o) });
  r.beginChat("u7", "t8");
  r.onNotify("turn/started", { threadId: "t8", turn: { id: "T8TURN" } });
  r.onNotify("item/reasoning/textDelta", { threadId: "t8", turnId: "T8TURN", itemId: "r1", delta: "思考" });
  ok(seen[1].action.type === "chat/responsePart" && seen[1].action.part.kind === "reasoning",
     "item/reasoning/textDelta → reasoning part（专用通道）");
  r.onNotify("item/reasoning/summaryTextDelta", { threadId: "t8", turnId: "T8TURN", itemId: "r1", delta: "续" });
  ok(seen[2].action.type === "chat/reasoning", "summaryTextDelta → chat/reasoning 续写");
}

console.log("\n[11] T4：token 用量 → chat/usage；MCP 启动态不产生噪声");
{
  const seen = [];
  const r = makeReflowTranslator({ fire: o => seen.push(o) });
  r.beginChat("u8", "t9");
  r.onNotify("turn/started", { threadId: "t9", turn: { id: "T9TURN" } });
  r.onNotify("thread/tokenUsage/updated", { threadId: "t9", turnId: "T9TURN", tokenUsage: { last: { inputTokens: 10, outputTokens: 20 } } });
  ok(seen[1].action.type === "chat/usage" && seen[1].action.usage.last.inputTokens === 10,
     "thread/tokenUsage/updated → chat/usage{turnId,usage}");
  const before = seen.length;
  r.onNotify("mcpServer/startupStatus/updated", { name: "x", status: "configured" });
  ok(seen.length === before, "mcpServer/startupStatus/updated 静默（保持协议对称，无 UI 噪声）");
}

console.log(`\n结果: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
