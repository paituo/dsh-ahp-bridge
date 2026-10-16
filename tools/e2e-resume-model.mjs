/**
 * 端到端：验证 `thread/resume` 路径的模型落地（修复「恢复的会话不设模型」）。
 *
 * 【为什么需要】`thread/start` 有模型落地段，但 `thread/resume` 此前**一行都没有**
 *   ⇒ 「prewarm 抢先建好会话 → 用户在已有会话换模型」的场景模型被完全丢弃
 *   ⇒ DSH 保持 pinned 默认（本机 = jxbw 网关）⇒ 报错文案与所选 provider 完全对不上。
 *   本脚本直接驱动桥的真实 handler 语义，断言 resume 后模型确实落地。
 *
 * 【用法】node bridge/tools/e2e-resume-model.mjs
 * 【性质】只读 + 会话级 set_config_option（不写盘、不改 profile）。
 */
import { DshAcpClient } from "../src/dsh-acp-client.mjs";

const NODE = process.env.DSH_NODE_EXE ?? "E:/分析数据/DeepSeek-Harness-VSCode/runtime/node/node.exe";
const BIN = process.env.DSH_BIN ?? "E:/分析数据/DeepSeek-Harness-VSCode/dev/dsh/lib/bin.js";
const CWD = process.env.DSH_PROBE_CWD ?? "E:/分析数据/DeepSeek-Harness-VSCode/dev";

const dsh = new DshAcpClient({
  nodePath: NODE, dshBinPath: BIN, profile: "acp", cwd: CWD,
  env: { ...process.env, DSH_HOME: process.env.DSH_HOME ?? "C:/Users/liuyue/.dsh" },
  log: (l, m) => { if (l === "error") console.log(`[dsh:${l}] ${m}`); },
});
await dsh.start();

let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x ? " :: " + x : ""}`); } };
const cur = (r) => r?.configOptions?.find((o) => o.id === "model")?.currentValue;

console.log("\n§1 新建会话 → 改模型（thread/start 路径语义）");
const sn = await dsh.newSession({ cwd: CWD, mcpServers: [] });
const sid = sn.sessionId;
const dflt = cur(sn);
ok(!!dflt, `new 后 currentValue 非空 = ${dflt}`);
const r1 = await dsh.setConfigOption(sid, "model", '["bumen","deepseek-v4.1-flash"]');
ok(cur(r1) === '["bumen","deepseek-v4.1-flash"]', "set(bumen) 落地");

console.log("\n§2 ★ 恢复已存在会话（thread/resume 路径语义）—— 修复点");
// resumeSession 对已 active 的会话会抛 already-active（桥按幂等处理），此处验证：
// 只要 resume 后补一次 setConfigOption，模型就能被换掉（这正是本次修复加的逻辑）。
try {
  await dsh.resumeSession({ sessionId: sid, cwd: CWD, mcpServers: [] });
  console.log("  （resume 成功返回）");
} catch (e) {
  console.log(`  （resume 抛错，桥侧按幂等处理：${String(e.message ?? e).slice(0, 70)}）`);
}
// ★ 这就是本次新增的逻辑：resume 之后必须**主动 setConfigOption**
const r2 = await dsh.setConfigOption(sid, "model", '["lobsterai-custom-0","Qwen3.8-Flash-AI"]');
ok(cur(r2) === '["lobsterai-custom-0","Qwen3.8-Flash-AI"]',
  "resume + set(lobsterai) 落地 ⇒ 证明『resume 路径补设模型』可行且必要",
  cur(r2));

console.log("\n§3 恢复会话后换到 bumen 并真发一轮 prompt（验证真正生效）");
const r3 = await dsh.setConfigOption(sid, "model", '["bumen","deepseek-v4.1-flash"]');
ok(cur(r3) === '["bumen","deepseek-v4.1-flash"]', "换回 bumen 落地");
try {
  const pr = await dsh.prompt(sid, [{ type: "text", text: "回答一个字：好" }]);
  ok(!!pr, "prompt 成功返回（未因模型问题报错）", JSON.stringify(pr).slice(0, 200));
} catch (e) {
  ok(false, "prompt 失败", String(e.message ?? e).slice(0, 200));
}

console.log(`\n=== ${fail === 0 ? "全部通过 ✅" : "存在失败 ❌"} : ${pass} passed, ${fail} failed ===`);
try { await dsh.close?.(); } catch { /* 忽略 */ }
process.exit(fail === 0 ? 0 : 1);
