#!/usr/bin/env node
/**
 * 端到端验证：turn 失败时 chat/error 的 part.error 经「序列化出网」后字段是否完整。
 * 直接防住本次真机缺陷：`错误: (undefined) undefined`。
 *
 * 背景（真机实证）：
 *   - 桥 emit 的消息经 src/rpc.mjs `JSON.stringify(msg)` 出网；
 *   - 若 part.error 是 `new Error()` 实例，message 是 non-enumerable ⇒ 被吞成 {}；
 *   - VS Code 模板 agentHost.turnError = "错误: ({0}) {1}"，{0}←errorType、{1}←message
 *     ⇒ 两侧 undefined ⇒ 用户看到 (undefined) undefined。
 *
 * 用法: node test/verify-error-serialize.mjs
 */

// 与 inject-snippet.mjs 的 errorPart 保持同构（唯一权威来源见源码）
const errorPart = (m, code) => {
  const message = String(m == null ? "error" : (m.message || m));
  return { kind: "error", error: { message, errorType: code != null ? String(code) : "TURN_FAILED" } };
};

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

const scenarios = [
  { name: "真机场景：api key 失效（有 message、无 code）",
    m: "Internal error: turn failed: Authentication Fails, Your api key: ****38Bf is invalid", code: undefined },
  { name: "带显式 code",
    m: "boom", code: "AUTH_FAILED" },
  { name: "空 message 兜底",
    m: null, code: undefined },
  { name: "对象形态 error（Kke/Qee 归一）",
    m: { message: "对象形态错误" }, code: undefined },
];

console.log("=== 修复验证：错误经 rpc.mjs 的 JSON.stringify 出网后 ===\n");

for (const s of scenarios) {
  console.log(`[${s.name}]`);
  const part = errorPart(s.m, s.code);
  const wire = JSON.parse(JSON.stringify({ type: "chat/error", turnId: "t1", duration: 0, part }));
  const F = wire.part.error;
  const rendered = "错误: ({0}) {1}".replace("{0}", F.errorType).replace("{1}", F.message);
  console.log(`  出网 part : ${JSON.stringify(wire.part)}`);
  console.log(`  VS Code 渲染: ${JSON.stringify(rendered)}`);
  ok(F.message !== undefined && F.message !== null && String(F.message).length > 0, "message 存活且非空");
  ok(typeof F.errorType === "string" && F.errorType.length > 0, "errorType 存活且非空（默认 TURN_FAILED）");
  ok(!rendered.includes("undefined"), "★ 渲染文本不含 undefined（真机报错的直接判据）");
  console.log("");
}

console.log("=== 对照：旧实现（new Error 实例）===");
{
  const bad = { kind: "error", error: new Error("Authentication Fails") };
  const wire = JSON.parse(JSON.stringify(bad));
  console.log(`  出网 part : ${JSON.stringify(wire)}`);
  const F = wire.error;
  const rendered = "错误: ({0}) {1}".replace("{0}", F.errorType).replace("{1}", F.message);
  console.log(`  VS Code 渲染: ${JSON.stringify(rendered)}   ← 这就是用户看到的报错`);
}

console.log(`\n=== 结果：${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
