// 离线验证：模型 id 裸值修复（双层前缀 → 单层） + 新旧形态解析兼容
// 运行：node test/sim-bareid.mjs
import { translateConfigOptionsToModels, translateModelSelectionToDsh, sessionNewToThreadStart } from "../src/translate.mjs";

const HOST_PREFIX = "agent-host-dsh";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } };

console.log("\n[1] 桥报出的模型 id 必须是裸值（不含 hostPrefix）");
{
  // 模拟 DSH session/new 的 configOptions（model 两级分组）
  const configOptions = [{
    id: "model", category: "model",
    currentValue: '["bumen","deepseek-v4.1-flash"]',
    options: [{
      group: "bumen", name: "Bumen",
      options: [
        { value: '["bumen","deepseek-v4.1-flash"]', name: "deepseek-v4.1-flash" },
        { value: '["bumen","deepseek-v4-pro"]', name: "deepseek-v4-pro" },
      ],
    }],
  }];
  const { models, currentModel } = translateConfigOptionsToModels(configOptions, HOST_PREFIX);
  ok(models.length === 2, `models 数量=2（实际 ${models.length}）`);
  ok(models.every((m) => !m.id.startsWith(HOST_PREFIX + ":")), "所有 id 均**不带** hostPrefix（裸值）");
  ok(models[0].id === '["bumen","deepseek-v4.1-flash"]', `id 为裸值（实际 ${models[0]?.id}）`);
  ok(models[0].rawValue === '["bumen","deepseek-v4.1-flash"]', "rawValue 保持 DSH 原始值");
  ok(!String(currentModel).startsWith(HOST_PREFIX + ":"), `currentModel 亦为裸值（实际 ${currentModel}）`);

  // 关键：模拟 VS Code 渲染层加一层前缀后的最终 id（应与 copilotcli 同构，单层）
  const vsCodeId = `${HOST_PREFIX}:${models[0].id}`;
  ok(vsCodeId === `agent-host-dsh:["bumen","deepseek-v4.1-flash"]`, `VS Code 补前缀后为**单层**（实际 ${vsCodeId}）`);
  ok(!vsCodeId.includes("agent-host-dsh:agent-host-dsh:"), "**不再**出现双层前缀");
}

console.log("\n[2] 解析兼容：单层 / 双层 / 裸值 / BYOK 全都能还原成 DSH value");
{
  const catalog = [
    { id: '["bumen","deepseek-v4.1-flash"]', rawValue: '["bumen","deepseek-v4.1-flash"]', name: "deepseek-v4.1-flash", provider: "bumen" },
    { id: '["lobsterai-custom-0","Qwen3.8-Flash-AI"]', rawValue: '["lobsterai-custom-0","Qwen3.8-Flash-AI"]', name: "Qwen3.8-Flash-AI", provider: "lobsterai-custom-0" },
  ];
  const cases = [
    ['agent-host-dsh:["bumen","deepseek-v4.1-flash"]', "单层前缀（新形态）"],
    ['agent-host-dsh:agent-host-dsh:["bumen","deepseek-v4.1-flash"]', "双层前缀（历史残留）"],
    ['["bumen","deepseek-v4.1-flash"]', "裸值（直接命中）"],
    ['agent-host-dsh:customendpoint/BoweiBM/deepseek-v4.1-flash', "BYOK 形态 + 单层前缀"],
    ['customendpoint/BoweiBM/deepseek-v4.1-flash', "BYOK 形态裸值"],
  ];
  for (const [input, desc] of cases) {
    const r = translateModelSelectionToDsh(input, HOST_PREFIX, catalog);
    ok(r && r.value === '["bumen","deepseek-v4.1-flash"]', `${desc} → ${r?.value ?? "undefined"} (${r?.matchedBy ?? "-"})`);
  }
  // 无法识别必须返回 undefined（绝不静默回落）
  const bad = translateModelSelectionToDsh("totally-unknown-model", HOST_PREFIX, catalog);
  ok(bad === undefined, "无法识别的模型 → undefined（拒绝而非静默回落）");
}

console.log("\n[3] sessionNewToThreadStart 的 models 同样为裸值");
{
  const r = sessionNewToThreadStart({
    sessionId: "s1",
    configOptions: [{
      id: "model", category: "model",
      currentValue: '["deepseek-official","deepseek-flash"]',
      options: [{ group: "deepseek-official", name: "D", options: [{ value: '["deepseek-official","deepseek-flash"]', name: "deepseek-flash" }] }],
    }],
  }, HOST_PREFIX);
  ok(Array.isArray(r.models) && r.models.length === 1, "models 数量=1");
  ok(r.models.every((m) => !m.id.startsWith("agent-host-")), "models[].id 均为裸值");
}

console.log(`\n结果: ${pass} passed, ${fail} failed, 共 ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
