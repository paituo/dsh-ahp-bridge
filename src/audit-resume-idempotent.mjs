/**
 * ★★★ 专项审计：`thread/resume` 的**幂等自愈**（2026-10-16 新增）
 *
 * 【治什么】用户报：
 *   错误: (CodexResumeFailed) Invalid params: session is already active: <uuid> (thread/resume)
 *   报错后该会话**再也发不出消息**。
 *
 * 【判据】`already active` 是「好消息型错误」—— resume 的目的就是让会话可用，
 *   而它报 active 恰证明会话是活的 ⇒ 必须当成功处理，绝不上抛。
 *
 * 【本脚本锁三件事】
 *   ① `asIdempotent()` 对幂等文案判定为真（含 writer-lock 变体）
 *   ② 对**真失败**文案判定为假（cwd 不符 / 会话不存在 ⇒ 仍须上抛，不许误吞）
 *   ③ `toRpcError()` 对真失败仍产出「message 带 hint」的可读错误（回归）
 *
 * 零外部依赖：只用 node:assert 风格自写断言，便于在任何环境直接跑。
 */

import { asIdempotent, classifyError, toRpcError, ErrorKind } from "./errors.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

console.log("=== A) 幂等信号：必须判为「可当成功」 ===");

// ★ 真机原文（逐字来自 agenthost.log 20261016T183837:1403）
const REAL = "Invalid params: session is already active: 593be7fd-c4ec-43ba-8fe0-99fdb1c20a5d";
ok("真机原文命中幂等", asIdempotent(REAL).idempotent === true, JSON.stringify(asIdempotent(REAL)));

// 包装成 Error 也须命中（上游可能带前缀 stage）
ok("Error 包装后仍命中", asIdempotent(new Error(REAL)).idempotent === true);
ok("带 stage 前缀仍命中",
  asIdempotent(new Error(`[resume] ${REAL}`)).idempotent === true);

// 另一条幂等形态：writer lock（codex 原生的「已有活跃写者」）
const WRITER = "thread ede15e23-44aa-4c74-a344-f041029b0b74 already has an active writer";
ok("writer-lock 形态命中", asIdempotent(WRITER).idempotent === true, JSON.stringify(asIdempotent(WRITER)));

// 大小写不敏感
ok("大写变体命中", asIdempotent("SESSION IS ALREADY ACTIVE: xyz").idempotent === true);

console.log("\n=== B) 反例：真失败**不许**被吞 ===");

// ★ cwd 不符：会话状态与请求真冲突，必须上抛（技能里已记为独立坑）
const CWD_MISMATCH = "Invalid params: session cwd does not match: expected C:\\a, got C:\\b";
ok("cwd 不符 ⇒ 非幂等（仍上抛）", asIdempotent(CWD_MISMATCH).idempotent === false);

// 会话不存在
ok("no rollout found ⇒ 非幂等",
  asIdempotent("no rollout found for thread id abc").idempotent === false);

// 未知会话
ok("unknown session ⇒ 非幂等",
  asIdempotent("unknown session 12345").idempotent === false);

// 空 / null 不得误判
ok("空串 ⇒ 非幂等", asIdempotent("").idempotent === false);
ok("null ⇒ 非幂等", asIdempotent(null).idempotent === false);
ok("undefined ⇒ 非幂等", asIdempotent(undefined).idempotent === false);

// ★ 关键反例：仅含 "active" 字样但语义相反 —— 不许宽泛匹配
ok("「未 active」不得误判",
  asIdempotent("session is not active yet, please retry").idempotent === false,
  JSON.stringify(asIdempotent("session is not active yet, please retry")));

console.log("\n=== C) 回归：真失败的错误可读化未被破坏 ===");

const rpc = toRpcError(new Error(CWD_MISMATCH), { stage: "resume", method: "thread/resume" });
ok("真失败仍产出 message", typeof rpc.message === "string" && rpc.message.length > 0);
ok("message 保留原文原因", rpc.message.includes("session cwd does not match"));
ok("data 带 stage/method", rpc.data?.stage === "resume" && rpc.data?.method === "thread/resume");
ok("data 保留 raw", typeof rpc.data?.raw === "string");

// AUTH 分类回归（上一轮修的）
const auth = classifyError(new Error("[AUTH] 403: 您的 IP 不在令牌允许访问的列表中"), { stage: "turn" });
ok("AUTH 分类未回归", auth.kind === ErrorKind.AUTH, auth.kind);
ok("AUTH hint 非空", typeof auth.hint === "string" && auth.hint.length > 0);

console.log("\n=== D) 幂等判定的「位置语义」自证 ===");
// 说明性断言：幂等必须**发生在 catch 内**，且判定为真时不得 rethrow。
// 这里以纯逻辑复刻桥内控制流，确保「命中⇒吞、未命中⇒抛」这一对语义正确。
function resumeControlFlow(err) {
  try {
    if (err) throw err;
    return { action: "resumed", threw: false };
  } catch (e) {
    const idem = asIdempotent(e);
    if (!idem.idempotent) throw e;          // 真失败 ⇒ 上抛
    return { action: "idempotent-ok", threw: false };   // 幂等 ⇒ 吞掉，当成功
  }
}
ok("幂等输入 ⇒ 不抛", resumeControlFlow(new Error(REAL)).threw === false);
ok("幂等输入 ⇒ 标记为成功路径",
  resumeControlFlow(new Error(REAL)).action === "idempotent-ok");
let threwOnReal = false;
try { resumeControlFlow(new Error(CWD_MISMATCH)); } catch { threwOnReal = true; }
ok("真失败输入 ⇒ 必抛", threwOnReal === true);

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
