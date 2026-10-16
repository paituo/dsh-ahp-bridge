/**
 * 端到端：桥出口 → VS Code 编解码 → 桥入口反解 → DSH 实际落地（真机）。
 *
 * 【为什么需要】单元测试只覆盖桥的单侧变换；本脚本把**官方算法**（`Iu`/`jr`/`y6`）
 *   与**真实 DSH 进程**串起来，一次跑完「UI 选中 → 回传 → y6 校验 → 桥反解 → DSH 落地」，
 *   任一环节断裂即报错 —— 这是「选 A 跑 B」类缺陷的**唯一可靠验收**。
 *
 * 【用法】node bridge/tools/e2e-model-roundtrip.mjs
 * 【性质】只读 + 会话级 set_config_option（不写盘、不改 profile）。
 */
import { toCodexModels, resolveDshModelValue } from "../src/translate.mjs";
import { DshAcpClient } from "../src/dsh-acp-client.mjs";

const nA = "@provider=";
const enc = (s) => encodeURIComponent(s);
const Iu = (p, m) => `${nA}${enc(p)}:${enc(m)}`;
const jr = (id) => {
  const i = id.indexOf(":", nA.length);
  return {
    modelProvider: decodeURIComponent(id.slice(nA.length, i)),
    modelId: decodeURIComponent(id.slice(i + 1)),
  };
};
/** 官方 `Yi` = provider 长名（**不是** model_provider "openai"）。 */
const CODEX_PROVIDER = "codex";
/** 官方 `y6` 逐字复刻。 */
const y6 = (r, cat, p) => {
  const t = cat.filter((s) => s.provider === p);
  const byId = t.filter((s) => s.id === r);
  const o = byId.length ? byId : t.filter((s) => s.name === r);
  return o.length === 1 ? o[0] : { __err: o.length ? "ambiguous" : "not-found" };
};

const NODE = process.env.DSH_NODE_EXE ?? "E:/分析数据/DeepSeek-Harness-VSCode/runtime/node/node.exe";
const BIN = process.env.DSH_BIN ?? "E:/分析数据/DeepSeek-Harness-VSCode/dev/dsh/lib/bin.js";
const CWD = process.env.DSH_PROBE_CWD ?? "E:/分析数据/DeepSeek-Harness-VSCode/dev";

const dsh = new DshAcpClient({
  nodePath: NODE, dshBinPath: BIN, profile: "acp", cwd: CWD,
  env: { ...process.env, DSH_HOME: process.env.DSH_HOME ?? "C:/Users/liuyue/.dsh" },
  log: (l, m) => { if (l === "warn" || l === "error") console.log(`[dsh:${l}] ${m}`); },
});
await dsh.start();

const sn = await dsh.newSession({ cwd: CWD, mcpServers: [] });
const grouped = sn.configOptions.find((o) => o.id === "model").options;
const flat = [];
for (const g of grouped) {
  for (const o of g.options) {
    const v = JSON.parse(o.value);
    flat.push({ id: o.value, name: o.name, rawValue: o.value, provider: v[0] });
  }
}
const label = (m) => `${m.provider}/${JSON.parse(m.rawValue)[1]}`;
console.log("DSH 清单:", flat.map(label).join("  |  "));

const cm = toCodexModels(flat);
const catalog = cm.map((g) => ({
  provider: CODEX_PROVIDER,
  id: Iu("openai", g.model),
  name: g.displayName,
  model: g.model,
}));

console.log("\n--- 逐条模拟「UI 选中 → 回传 → y6 校验 → 桥反解 → DSH 落地」---");
let allPass = true;
for (const m of cm) {
  const uiId = Iu("openai", m.model);
  const back = jr(uiId).modelId;
  const hit = y6(back, catalog, CODEX_PROVIDER);
  const resolved = resolveDshModelValue(back, "openai", flat);
  const expect = flat.find((f) => label(f) === m.model)?.rawValue;
  const okY6 = !!hit && !hit.__err && hit.model === m.model;
  const okRes = resolved === expect;
  let landed = "skip";
  if (okRes) {
    try {
      const r = await dsh.setConfigOption(sn.sessionId, "model", resolved);
      const cv = r?.configOptions?.find((o) => o.id === "model")?.currentValue;
      landed = cv === resolved ? "✅" : `❌(${cv})`;
    } catch (e) { landed = "ERR:" + String(e.message ?? e).slice(0, 60); }
  }
  if (!okY6 || !okRes) allPass = false;
  console.log(`  ${m.model}`);
  console.log(`     y6=${okY6 ? "✅" : "❌"}   桥反解=${okRes ? "✅" : "❌ " + resolved + " (期望 " + expect + ")"}   DSH落地=${landed}`);
}
console.log(`\n=== ${allPass ? "全部通过 ✅" : "存在失败 ❌"} ===`);
try { await dsh.close?.(); } catch { /* 忽略 */ }
process.exit(allPass ? 0 : 1);
