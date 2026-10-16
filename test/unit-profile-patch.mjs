// 单测：profile-patch.mjs 的合并逻辑（纯文本级，不碰真实文件）
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const mod = await import("../src/profile-patch.mjs");
const {
  mergeProvidersIntoPatch, extractProviderNames, isHmrEnabled,
  byokToDshProviders, normalizeKey, parsePatch, __internal,
} = mod;

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = typeof got === "string" ? got : JSON.stringify(got);
  const w = typeof want === "string" ? want : JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}\n     got : ${g}\n     want: ${w}`); }
}
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? "\n     " + extra : ""}`); }
}

// 真实 patch 的缩略版（含 llm-pi-ai + hmr）
const BASE = `# header comment
# line two

- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      lobsterai-custom-0:
        displayName: LobsterAI · jxbw
        apiKeyEnv: LOBSTERAI_CUSTOM_0_API_KEY
        api: openai-completions
        baseURL: https://ai.jxbw.com/v1
        models:
          - id: Qwen3.8-Flash-AI
            name: Qwen3.8-Flash-AI
      bumen:
        apiKeyEnv: BUMEN_API_KEY
        api: openai-completions
        baseURL: http://172.20.0.145:8810/v1
        models:
          - id: deepseek-v4.1-flash
            name: deepseek-v4.1-flash

- id: hmr
  name: "@deepseek-ai/dsh-hmr"
  disabled: false
  config:
    root: []
`;

console.log("\n=== 1. 解析基础 ===");
eq("extractProviderNames", extractProviderNames(BASE), ["lobsterai-custom-0", "bumen"]);
eq("isHmrEnabled = true", isHmrEnabled(BASE), true);
eq("isHmrEnabled(disabled:true) = false",
  isHmrEnabled(BASE.replace("disabled: false", "disabled: true")), false);

console.log("\n=== 2. byok → provider 映射 ===");
const byok = [
  { name: "Bowei", vendor: "customendpoint", apiKey: "${input:chat.lm.secret.604fc222}",
    models: [{ id: "Qwen3.8-Flash-AI", name: "Qwen3.8-Flash-AI", url: "https://ai.jxbw.com/v1" },
             { id: "Qwen3.7-plus-AI", name: "Qwen3.7-plus-AI", url: "https://ai.jxbw.com/v1" }] },
  { name: "BoweiBM", vendor: "customendpoint", apiKey: "${input:chat.lm.secret.-28e3dd35}",
    models: [{ id: "deepseek-v4-flash", name: "deepseek-v4-flash", url: "http://172.20.0.145:8810/v1" },
             { id: "deepseek-v4.1-flash", name: "deepseek-v4.1-flash", url: "http://172.20.0.145:8810/v1" }] },
];
const provs = byokToDshProviders(byok);
eq("provider 数量", provs.length, 2);
eq("key 归一化", provs.map((p) => p.key), ["bowei", "boweibm"]);
eq("apiKeyEnv 形态", provs.map((p) => p.apiKeyEnv), ["BOWEI_AHP_BYOK_BOWEI_API_KEY", "BOWEI_AHP_BYOK_BOWEIBM_API_KEY"]);
eq("baseURL 取首模型 url", provs.map((p) => p.baseURL), ["https://ai.jxbw.com/v1", "http://172.20.0.145:8810/v1"]);
ok("_source 标注密钥未桥接", provs[0]._source.apiKeyRef === "(secret, not bridged)");
eq("normalizeKey 边界", [normalizeKey("A b_C"), normalizeKey("---x---"), normalizeKey("")], ["a-b-c", "x", ""]);

console.log("\n=== 3. 合并：保留原生 provider（整体替换语义的关键）===");
const r3 = mergeProvidersIntoPatch(BASE, provs);
eq("changed", r3.changed, true);
eq("added", r3.added, ["bowei", "boweibm"]);
const after3 = extractProviderNames(r3.text);
eq("合并后含全部 4 个 provider", after3, ["lobsterai-custom-0", "bumen", "bowei", "boweibm"]);
ok("hmr 条目仍在", isHmrEnabled(r3.text), "hmr 被破坏！");
ok("注释头仍在", r3.text.includes("# header comment"));
ok("bumen 内容完整", r3.text.includes("BUmen".replace("U", "U").toLowerCase().includes("x") ? "" : "BUMEN_API_KEY"));
ok("baseURL 正确写入", r3.text.includes("baseURL: http://172.20.0.145:8810/v1"));

console.log("\n=== 4. 幂等：同输入第二次 → changed=false ===");
const r4 = mergeProvidersIntoPatch(r3.text, provs);
eq("第二次 changed = false", r4.changed, false);
eq("第二次 added = []", r4.added, []);
eq("文本逐字相同", r4.text === r3.text, true);

console.log("\n=== 5. managedKeys 清理：改名的旧项被移除 ===");
const r5 = mergeProvidersIntoPatch(r3.text, [{
  key: "bowei", displayName: "Bowei", apiKeyEnv: "BOWEI_AHP_BYOK_BOWEI_API_KEY",
  api: "openai-completions", baseURL: "https://ai.jxbw.com/v1", models: [{ id: "Qwen3.8-Flash-AI", name: "Qwen3.8-Flash-AI" }],
}], { managedKeys: ["boweibm"] });
const after5 = extractProviderNames(r5.text);
ok("boweibm 被移除（在 managedKeys 里且本次未提供）", !after5.includes("boweibm"), JSON.stringify(after5));
ok("原生 lobsterai-custom-0 未受影响", after5.includes("lobsterai-custom-0"));
ok("原生 bumen 未受影响", after5.includes("bumen"));
ok("bowei 仍在", after5.includes("bowei"));

console.log("\n=== 6. 无 llm-pi-ai 条目 → 新建 ===");
const NOENTRY = `# only hmr\n- id: hmr\n  disabled: false\n`;
const r6 = mergeProvidersIntoPatch(NOENTRY, provs);
ok("新建了 llm-pi-ai", r6.text.includes("- id: llm-pi-ai"));
eq("新条目含 2 provider", extractProviderNames(r6.text), ["bowei", "boweibm"]);
ok("hmr 仍启用", isHmrEnabled(r6.text));

console.log("\n=== 7. 有 llm-pi-ai 但无 providers 段 ===");
const NOPROV = `- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    foo: 1\n\n- id: hmr\n  disabled: false\n`;
const r7 = mergeProvidersIntoPatch(NOPROV, provs);
eq("补出 providers", extractProviderNames(r7.text), ["bowei", "boweibm"]);
ok("原有 config.foo 保留", r7.text.includes("foo: 1"));
ok("hmr 仍启用", isHmrEnabled(r7.text));

console.log("\n=== 8. 真实文件上的 dry-run（只读，不写）===");
const real = "C:/Users/liuyue/.dsh/profiles/acp/cordis.patch.yml";
if (fs.existsSync(real)) {
  const text = fs.readFileSync(real, "utf8");
  const before = extractProviderNames(text);
  console.log(`     现有 provider: [${before.join(", ")}]  hmr=${isHmrEnabled(text)}`);
  const d = mergeProvidersIntoPatch(text, provs);
  const afterD = extractProviderNames(d.text);
  eq("dry-run 后 provider 数 = 原 + 2", afterD.length, before.length + 2);
  ok("dry-run 保持原生全在", before.every((k) => afterD.includes(k)), JSON.stringify({ before, afterD }));
  ok("dry-run hmr 仍启用", isHmrEnabled(d.text));
  ok("dry-run 不动真实文件", fs.readFileSync(real, "utf8") === text);
} else {
  console.log("     (跳过：真实 patch 不存在)");
}

console.log(`\n########## 单测结果：${pass} 通过 / ${fail} 失败 ##########`);
process.exit(fail ? 1 : 0);
