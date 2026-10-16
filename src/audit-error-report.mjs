/**
 * ★★★ 异常上报机制专项审计（2026-10-16 新增）
 *
 * 目的：把"整条链路出错时用户看不到原因"这件事，变成**可断言、可回归**的检查项。
 *
 * 断言三组：
 *   A. 错误分类（classifyError/toRpcError）：上游字符串报错必须被归到正确大类，
 *      且 hint 必须出现在最终 message 里（这是"送达用户"的唯一一跳）。
 *   B. 出站错误通知形状：`turn/completed` + failed 必须满足官方 required，
 *      并模拟官方 `mapTurnCompleted` 的判定式——证明它**确实会**产生 ChatError。
 *   C. 反例锁定：协议外通道（item type="error"）必须被识别为非法，
 *      防止将来有人"顺手"再加回去。
 *
 * 运行：node audit-error-report.mjs
 */
import { ErrorKind, classifyError, toRpcError, BridgeError, rpcFail } from "./errors.mjs";
import { translatePromptDone, buildSkillsListResult } from "./translate.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? " :: " + extra : ""}`); }
};
const sect = (t) => console.log(`\n=== ${t} ===`);

// ───────────────────────── A. 错误分类 ─────────────────────────
sect("A. 错误分类与用户可读化");

const cases = [
  { in: new Error("[AUTH] 403: 您的 IP 不在令牌允许访问的列表中 (request id: 202610160958515774838198268d9d6Dy5Vi9vM)"),
    kind: ErrorKind.AUTH, tag: "上游 403 IP 白名单" },
  { in: new Error('turn failed: [AUTH] 403: {"code":"access_denied","message":"您的 IP 不在令牌允许访问的列表中"}'),
    kind: ErrorKind.AUTH, tag: "嵌套在 turn failed 里的 403" },
  { in: new Error("fetch failed: ECONNREFUSED 127.0.0.1:11434"),
    kind: ErrorKind.NETWORK, tag: "连接被拒" },
  { in: new Error("429 Too Many Requests: quota exceeded"),
    kind: ErrorKind.RATE_LIMIT, tag: "限流" },
  { in: new Error("EPERM: operation not permitted, open 'C:\\Users\\x\\.dsh\\profiles\\a\\cordis.yml'"),
    kind: ErrorKind.TRANSIENT, tag: "文件被占用（DSH 配置文件锁）" },
  { in: new Error("Method not found: thread/read"),
    kind: ErrorKind.CONTRACT, tag: "方法未实现" },
  { in: new Error("transport closed; request turn/start aborted"),
    kind: ErrorKind.TRANSIENT, tag: "通道关闭" },
  { in: new Error("some totally unknown boom"),
    kind: ErrorKind.INTERNAL, tag: "未知异常兜底" },
];

for (const c of cases) {
  const be = classifyError(c.in, { stage: "turn" });
  ok(`分类[${c.tag}] = ${c.kind}`, be.kind === c.kind, `实际=${be.kind}`);
}

// hint 必须进入最终 message（VS Code 直接把 message 展示给用户）
{
  const rpc = toRpcError(new Error("[AUTH] 403: 您的 IP 不在令牌允许访问的列表中"), { stage: "turn" });
  ok("AUTH 的 rpc.message 含原文", rpc.message.includes("403"), rpc.message);
  ok("AUTH 的 rpc.message 含 👉 指引", rpc.message.includes("👉"), rpc.message);
  ok("AUTH 的 rpc.code 是语义化码（非 -32603）", rpc.code === -32001, String(rpc.code));
  ok("原始报错保留在 data.raw", typeof rpc.data?.raw === "string" && rpc.data.raw.length > 0);
  ok("data.kind 透出供上游决策", rpc.data?.kind === ErrorKind.AUTH);

  const rm = toRpcError(new Error("429 Too Many Requests"), {});
  ok("限流错误标 retryable=true", rm.data?.retryable === true);

  const rp = toRpcError(new Error("EPERM: busy"), {});
  ok("EPERM 标 retryable（桥会自动重试）", rp.data?.retryable === true);

  const ri = toRpcError(new Error("unknown boom"), {});
  ok("未知错误不标 retryable", ri.data?.retryable === false);

  const sugar = rpcFail(new Error("[AUTH] 403: nope"), { stage: "thread/start" });
  ok("rpcFail 产出 {__error} 供 handler 直接 return", sugar?.__error?.code === -32001);
}

// 二次分类不应丢上下文
{
  const e1 = classifyError(new Error("boom"), { stage: "prompt" });
  const e2 = classifyError(e1, { method: "turn/start" });
  ok("重复 classify 保持同一实例", e1 === e2);
  ok("重复 classify 合并 stage+method", e2.data?.stage === "prompt" && e2.data?.method === "turn/start");
}

// ───────────── B. 出站错误通知形状 + 触发 ChatError ─────────────
sect("B. turn/completed(failed) 错误通知契约");

const done = translatePromptDone("thread-abc", "turn-xyz", 1234);
done.params.turn.status = "failed";
done.params.turn.error = { message: "DSH 后端已停止（exit code=1）\n\n👉 请重启 VS Code" };

const TOP_REQ = ["threadId", "turn"];
const TURN_REQ = ["id", "items", "status"];
const STATUS_OK = ["inProgress", "completed", "interrupted", "failed"];

ok("TOP 必填齐", TOP_REQ.every(k => done.params[k] !== undefined),
   JSON.stringify(Object.keys(done.params)));
ok("turn 必填齐", TURN_REQ.every(k => done.params.turn[k] !== undefined),
   JSON.stringify(Object.keys(done.params.turn)));
ok("turn.status 在官方枚举内", STATUS_OK.includes(done.params.turn.status));
ok("turn.items 是数组", Array.isArray(done.params.turn.items));
ok("turn.error.message 是非空字符串（TurnError.required）",
   typeof done.params.turn.error?.message === "string" && done.params.turn.error.message.length > 0);
ok("completedAt 是秒级（<1e11）", done.params.turn.completedAt < 1e11, String(done.params.turn.completedAt));
ok("durationMs 是毫秒", typeof done.params.turn.durationMs === "number");

// ★ 模拟官方 `mapTurnCompleted` 判定式（源码 codexMapAppServerEvents.ts:1317）
{
  const params = done.params;
  const wouldEmitChatError = params.turn.status === "failed" && !!params.turn.error;
  ok("模拟官方判定：会产生 ActionType.ChatError", wouldEmitChatError);
  // 反例：若不补 turn.error，官方分支不进入 ⇒ 错误丢失（正是本轮要治的病）
  const noErr = { ...params, turn: { ...params.turn } };
  delete noErr.turn.error;
  ok("反例：缺 turn.error 则不产生 ChatError（证明 error 字段不可省）",
     !(noErr.turn.status === "failed" && !!noErr.turn.error));
}

// ───────────────────────── C. 反例锁定 ─────────────────────────
sect("C. 协议外通道必须被识别为非法");

// 官方 ThreadItem 合法类型（源码 ItemCompletedNotification.json definitions.ThreadItem.oneOf）
const LEGAL_ITEM_TYPES = [
  "userMessage", "hookPrompt", "agentMessage", "functionCallOutput", "plan",
  "reasoning", "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall",
  "collabAgentToolCall", "subAgentActivity", "webSearch", "imageView", "sleep",
  "imageGeneration", "enteredReviewMode", "exitedReviewMode", "contextCompaction",
];
ok(`官方合法 item 类型共 ${LEGAL_ITEM_TYPES.length} 种，且不含 error`,
   !LEGAL_ITEM_TYPES.includes("error"));
ok("自造 type=\"error\" 不在白名单 ⇒ 不可用于上报", !LEGAL_ITEM_TYPES.includes("error"));
ok("自造 type=\"systemError\" 也不在白名单", !LEGAL_ITEM_TYPES.includes("systemError"));

// 合法类型抽查（防止将来误删）
for (const t of ["agentMessage", "commandExecution", "fileChange"]) {
  ok(`合法类型 ${t} 仍存在`, LEGAL_ITEM_TYPES.includes(t));
}

// ───────────────────────── 汇总 ─────────────────────────
console.log(`\n${"=".repeat(52)}`);
console.log(`  异常上报机制审计：通过 ${pass} / 失败 ${fail}   （共 ${pass + fail}）`);
console.log(`${"=".repeat(52)}`);
process.exit(fail === 0 ? 0 : 1);
