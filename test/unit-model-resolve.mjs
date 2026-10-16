// 单元测试：translateModelSelectionToDsh 的多路解析
import { translateModelSelectionToDsh, resolveDshModelValue, toCodexModels } from "../src/translate.mjs";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  ✓ " + msg); } else { fail++; console.log("  ✗ " + msg); } };

const HOST = "agent-host-dsh";
// 模拟桥缓存的模型清单（translateConfigOptionsToModels 产物）
const CATALOG = [
  { id: `${HOST}:["deepseek-official","deepseek-v4-flash"]`, name: "deepseek-v4-flash", rawValue: '["deepseek-official","deepseek-v4-flash"]', provider: "deepseek-official" },
  { id: `${HOST}:["lobsterai-custom-0","Qwen3.8-Flash-AI"]`, name: "Qwen3.8-Flash-AI", rawValue: '["lobsterai-custom-0","Qwen3.8-Flash-AI"]', provider: "lobsterai-custom-0" },
  { id: `${HOST}:["bumen","deepseek-v4.1-flash"]`, name: "deepseek-v4.1-flash", rawValue: '["bumen","deepseek-v4.1-flash"]', provider: "bumen" },
];

console.log("[1] 原路径：agent-host-dsh: 前缀（rawValue 为 JSON 字符串）");
{
  const r = translateModelSelectionToDsh(`${HOST}:["lobsterai-custom-0","Qwen3.8-Flash-AI"]`, HOST, CATALOG);
  ok(r?.value === '["lobsterai-custom-0","Qwen3.8-Flash-AI"]', "剥离前缀得到合法 DSH value");
  ok(r?.matchedBy === "dsh-value", "matchedBy=dsh-value");
}

console.log("\n[2] 核心血案：customendpoint/<vendor>/<model> 形态");
{
  const r = translateModelSelectionToDsh("customendpoint/Bowei/Qwen3.8-Flash-AI", HOST, CATALOG);
  ok(r?.value === '["lobsterai-custom-0","Qwen3.8-Flash-AI"]', "customendpoint/Bowei/Qwen3.8-Flash-AI → lobsterai value");
  ok(r?.matchedBy === "resolved-by-name", "matchedBy=resolved-by-name");
}

console.log("\n[3] 纯模型名");
{
  const r = translateModelSelectionToDsh("Qwen3.8-Flash-AI", HOST, CATALOG);
  ok(r?.value === '["lobsterai-custom-0","Qwen3.8-Flash-AI"]', "纯名 → lobsterai value");
}

console.log("\n[4] 已是合法 DSH value（不经前缀）");
{
  const r = translateModelSelectionToDsh('["bumen","deepseek-v4.1-flash"]', HOST, CATALOG);
  ok(r?.value === '["bumen","deepseek-v4.1-flash"]', "合法 value 原样通过");
  ok(r?.matchedBy === "dsh-value", "matchedBy=dsh-value");
}

console.log("\n[5] 未知模型 → undefined（拒绝静默回落）");
{
  const r = translateModelSelectionToDsh("customendpoint/Foo/NotExist", HOST, CATALOG);
  ok(r === undefined, "未知模型返回 undefined（调用方将明确报错）");
}

console.log("\n[6] 非法输入");
{
  ok(translateModelSelectionToDsh(undefined, HOST, CATALOG) === undefined, "undefined 输入 → undefined");
  ok(translateModelSelectionToDsh("", HOST, CATALOG) === undefined, "空串 → undefined");
  ok(translateModelSelectionToDsh("[]", HOST, CATALOG) === undefined, "非法 JSON 数组 → undefined");
}

console.log("\n[7] ★ 模型歧义修复（2026-10-16）：provider/模型名 精确反解");
{
  // 血案清单：deepseek-flash 同时存在于 deepseek-official 与 deepseek-account
  const AMB = [
    { id: `${HOST}:["deepseek-official","deepseek-flash"]`, name: "deepseek-flash", rawValue: '["deepseek-official","deepseek-flash"]', provider: "deepseek-official" },
    { id: `${HOST}:["deepseek-account","deepseek-flash"]`, name: "deepseek-flash", rawValue: '["deepseek-account","deepseek-flash"]', provider: "deepseek-account" },
    { id: `${HOST}:["bumen","deepseek-v4.1-flash"]`, name: "deepseek-v4.1-flash", rawValue: '["bumen","deepseek-v4.1-flash"]', provider: "bumen" },
  ];
  const a = translateModelSelectionToDsh("deepseek-official/deepseek-flash", HOST, AMB);
  ok(a?.value === '["deepseek-official","deepseek-flash"]', "provider/名 → 精确命中 official（不再被末段名抢先）");
  ok(a?.matchedBy === "resolved-by-provider-exact", "matchedBy=resolved-by-provider-exact");

  const b = translateModelSelectionToDsh("deepseek-account/deepseek-flash", HOST, AMB);
  ok(b?.value === '["deepseek-account","deepseek-flash"]', "同裸名不同 provider → 各自精确命中（歧义消除）");

  const c = translateModelSelectionToDsh("bumen/deepseek-v4.1-flash", HOST, AMB);
  ok(c?.value === '["bumen","deepseek-v4.1-flash"]', "用户自定义模型精确命中");
}

console.log("\n[8] ★ resolveDshModelValue 同口径（thread/start 路径）");
{
  const AMB = [
    { name: "deepseek-flash", rawValue: '["deepseek-official","deepseek-flash"]', provider: "deepseek-official" },
    { name: "deepseek-flash", rawValue: '["deepseek-account","deepseek-flash"]', provider: "deepseek-account" },
    { name: "deepseek-v4.1-flash", rawValue: '["bumen","deepseek-v4.1-flash"]', provider: "bumen" },
  ];
  ok(resolveDshModelValue("deepseek-account/deepseek-flash", "openai", AMB) === '["deepseek-account","deepseek-flash"]', "resolveDshModelValue: account 精确命中");
  ok(resolveDshModelValue("bumen/deepseek-v4.1-flash", "openai", AMB) === '["bumen","deepseek-v4.1-flash"]', "resolveDshModelValue: bumen 精确命中");
  // 歧义裸名：必须**拒绝猜测**（返回 undefined 让调用方报错，而不是静默取首项）
  ok(resolveDshModelValue("deepseek-flash", "openai", AMB) === undefined, "歧义裸名 → undefined（拒绝静默猜首项）");
}

console.log("\n[9] ★ toCodexModels 出口契约（v2：model 与 displayName 必须同源）");
{
  const out = toCodexModels([
    { name: "deepseek-flash", rawValue: '["deepseek-official","deepseek-flash"]', provider: "deepseek-official" },
    { name: "deepseek-flash", rawValue: '["deepseek-account","deepseek-flash"]', provider: "deepseek-account" },
    { name: "Qwen3.8-Flash-AI", rawValue: '["lobsterai-custom-0","Qwen3.8-Flash-AI"]', provider: "lobsterai-custom-0" },
  ]);
  ok(out[0].model === "deepseek-official/deepseek-flash", "model 字段 = provider/名（VS Code 回传后即可精确反解）");
  ok(out[1].model === "deepseek-account/deepseek-flash", "同裸名第二条 model 不同（消除歧义）");
  // ★★★ v2 契约（2026-10-16 二次定案）：displayName **必须等于 model**。
  //   v1 曾让重名条目 displayName = `名 (provider)`（干净名 + 后缀）、无重名者保持裸名，
  //   结果官方 `y6()` 校验（by-name 比 `displayName`，by-id 比 URL 编码 id 必落空）
  //   两条路全落空 ⇒ 抛错 ⇒ VS Code 兜底取同 provider 首项 ⇒ 用户选的模型被静默替换。
  //   故此处断言"同源"，而非"干净名"。详见 unit-model-selection-contract.mjs。
  ok(out[0].displayName === out[0].model, "displayName 与 model 同源（重名条目）⇒ 过 y6 by-name 校验");
  ok(out[1].displayName === out[1].model, "displayName 与 model 同源（重名第二条）");
  ok(out[2].displayName === out[2].model, "displayName 与 model 同源（无重名条目，行为一致）");
  ok(out[0].displayName !== out[1].displayName, "同名不同 provider 的 displayName 可区分");
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
