/**
 * 契约测试：`model/list` 出口必须让 VS Code 的 `y6()` 模型选择校验通过。
 *
 * ════════════════════════════════════════════════════════════════════════
 * 【为什么必须有这个测试 —— 两次真机血案】
 *
 * 官方 `create_session` / `create_chat` 收到 UI 回传的模型参数后，
 * 会过 `y6(r, catalog, provider)` 校验（见 `agentHostMain.js`）：
 *
 *     function y6(r, catalog, provider) {
 *       let t = provider === undefined ? catalog : catalog.filter(s => s.provider === provider);
 *       let n = t.filter(s => s.id === r);
 *       let o = n.length > 0 ? n : t.filter(s => s.name === r);
 *       if (o.length === 0) throw new Error(`... model must match an available model id or name ...`);
 *       if (o.length > 1)   throw new Error(`... is ambiguous ...`);
 *       return o[0];
 *     }
 *
 * 其中（`_refreshCodexModels` 装配）：
 *     catalog[].id   = `@provider=${enc(model_provider)}:${enc(model.model)}`   ← 由 `model` 决定
 *     catalog[].name = `model.displayName`                                      ← 由 `displayName` 决定
 *
 * 而 UI 回传的待校验值 `r` = `jr(selectionId).modelId` = **`model` 字段原文**。
 *
 * ⇒ **铁律：`model` 字段必须同时出现在 `id`、`name`、`r` 三处**，
 *    否则 `y6` 两条路全落空 ⇒ 抛错 ⇒ VS Code `_resolveModelFromCatalog` 兜底
 *    ⇒ 取「同 provider 首项」 ⇒ **用户选的模型被静默替换**（两次血案：401 / 403）。
 *
 * 【血案一】`model` 给裸名 `deepseek-flash` ⇒ 跨 provider 同名项不可区分 ⇒ 选 A 跑 B。
 * 【血案二】只把 `model` 改成 `provider/名`，`displayName` 留干净名 ⇒ `y6` 两条路全落空。
 * ════════════════════════════════════════════════════════════════════════
 */
import { toCodexModels } from "../src/translate.mjs";

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? " :: " + extra : ""}`); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// —— 忠实复刻官方的编解码与校验（与 agentHostMain.js 逐字对齐）——
//
// ★ `CODEX_PROVIDER` 的来源（易错点，本测试第一版就踩了）：
//   `y6(r, catalog, provider)` 的 `provider` 实参来自
//     `bSe(...)`: `y6(c, e, s === "currentSession" ? t : void 0)`
//     其中 `t = l?.provider ?? (o ? (await r.getSession(o))?.provider ?? F.provider(o) : void 0)`
//   即 **provider 的长名**（`Yi = "codex"`），**不是** `model_provider`（`"openai"`）。
//   而 `catalog[].provider` 也恒为 `Yi`（`_refreshCodexModels` 装配）。
//   ⇒ 两边一致 ⇒ provider 过滤不会误杀。若测试误传 `"openai"` ⇒ 空集 ⇒ 假阴性。
const CODEX_PROVIDER = "codex";
const nA = "@provider=", aB = "vscode-proxy";
const Iu = (p, m) => `${nA}${encodeURIComponent(p)}:${encodeURIComponent(m)}`;
const jr = (id) => {
  if (!id.startsWith(nA)) return { modelProvider: aB, modelId: id };
  const i = id.indexOf(":", nA.length);
  if (i < nA.length) return { modelProvider: aB, modelId: id };
  try {
    return { modelProvider: decodeURIComponent(id.slice(nA.length, i)), modelId: decodeURIComponent(id.slice(i + 1)) };
  } catch { return { modelProvider: aB, modelId: id }; }
};
/** 官方 `_refreshCodexModels` 的 catalog 装配（model_provider 取自 config/read = "openai"）。 */
const buildCatalog = (codexModels, modelProvider = "openai") =>
  codexModels
    .sort((g, h) => Number(h.isDefault) - Number(g.isDefault))
    .map((g) => ({
      provider: "codex",
      id: Iu(modelProvider, g.model),
      name: g.displayName,
      model: g.model,
    }));
/** 官方 `y6` 逐字复刻。 */
const y6 = (r, catalog, provider) => {
  if (r === undefined) return undefined;
  const t = provider === undefined ? catalog : catalog.filter((s) => s.provider === provider);
  const n = t.filter((s) => s.id === r);
  const o = n.length > 0 ? n : t.filter((s) => s.name === r);
  if (o.length === 0) return { __err: "not-found" };
  if (o.length > 1) return { __err: "ambiguous" };
  return o[0];
};

// —— 本机真实 DSH 清单（2026-10-16 实测，含跨 provider 同名项）——
const DSH_MODELS = [
  { id: '["deepseek-official","deepseek-flash"]', name: "DeepSeek-V41-Flash", rawValue: '["deepseek-official","deepseek-flash"]', provider: "deepseek-official" },
  { id: '["deepseek-official","deepseek-v4-pro"]', name: "DeepSeek-V4-Pro", rawValue: '["deepseek-official","deepseek-v4-pro"]', provider: "deepseek-official" },
  { id: '["deepseek-account","deepseek-flash"]', name: "DeepSeek-V41-Flash", rawValue: '["deepseek-account","deepseek-flash"]', provider: "deepseek-account" },
  { id: '["deepseek-account","deepseek-v4-pro"]', name: "DeepSeek-V4-Pro", rawValue: '["deepseek-account","deepseek-v4-pro"]', provider: "deepseek-account" },
  { id: '["lobsterai-custom-0","Qwen3.8-Flash-AI"]', name: "Qwen3.8-Flash-AI", rawValue: '["lobsterai-custom-0","Qwen3.8-Flash-AI"]', provider: "lobsterai-custom-0" },
  { id: '["bumen","deepseek-v4.1-flash"]', name: "deepseek-v4.1-flash", rawValue: '["bumen","deepseek-v4.1-flash"]', provider: "bumen" },
  { id: '["ninfer-local","bonsai2-27b"]', name: "Bonsai-2-27B-Ternary", rawValue: '["ninfer-local","bonsai2-27b"]', provider: "ninfer-local" },
];

console.log("\n§1 桥出口形状：`model` 必须带 provider 前缀（契约①：跨 provider 可区分）");
const cm = toCodexModels(DSH_MODELS);
{
  const zwei = cm.filter((m) => /deepseek-flash$/.test(m.model));
  ok(zwei.length === 2, "同名模型有 2 条", `实际 ${zwei.length}`);
  ok(zwei[0].model !== zwei[1].model, "两者 `model` 不相等（可区分）",
    `${zwei[0]?.model} vs ${zwei[1]?.model}`);
  ok(zwei[0].id !== zwei[1].id, "两者 `id` 不相等");
}

console.log("\n§2 ★ 铁律：对**每一条**模型，`y6` 校验必须命中且唯一（契约②）");
{
  const catalog = buildCatalog(cm);
  let allOk = true;
  for (const m of cm) {
    const uiId = Iu("openai", m.model);            // UI 侧按 catalog 装配出的 selectionId
    const back = jr(uiId).modelId;                 // UI 回传给 create_session 的值
    const hit = y6(back, catalog, CODEX_PROVIDER);
    // ★ 命中判据：无反查错误，且命中的就是**本条目**（用 catalog 索引回指，避免 id 编码干扰）
    const good = hit && !hit.__err && hit.model === m.model;
    if (!good) {
      allOk = false;
      console.log(`    ❌ model=${m.model} → y6("${back}") → ${hit?.__err ?? "mismatch"}`);
    }
  }
  ok(allOk, `全部 ${cm.length} 条模型均可通过 y6 校验且唯一命中`);

  // ★ 额外钉死：by-id 路**必然失败**（catalog.id 是 URL 编码的，而回传值是解码原文）
  //   ⇒ 这解释了为什么「by-name 路必须命中」是硬约束，而不是可选项。
  const anyById = cm.some((m) => catalog.some((s) => s.id === jr(Iu("openai", m.model)).modelId));
  ok(anyById === false, "by-id 路必然落空（id 含 %2F 编码）⇒ by-name 是唯一活路");
}

console.log("\n§3 ★ 反例钉死：`displayName` 与 `model` 不同源 ⇒ 必然校验失败（血案二）");
{
  // 复刻 v1 的错误实现：model 带 provider、displayName 留干净名
  const v1 = DSH_MODELS.map((m) => {
    const p = JSON.parse(m.rawValue);
    return { model: `${p[0]}/${p[1]}`, displayName: m.name, isDefault: false };
  });
  const catV1 = buildCatalog(v1);
  let allFail = true;
  for (const m of v1) {
    const back = jr(Iu("openai", m.model)).modelId;
    const hit = y6(back, catV1, CODEX_PROVIDER);
    if (!hit || !hit.__err) allFail = false;
  }
  ok(allFail, "v1 形态（displayName≠model）全部校验失败 —— 证明该缺陷确实存在");
}

console.log("\n§4 `displayName` 必须等于 `model`（UI 显示与校验值同源）");
{
  const bad = cm.filter((m) => m.displayName !== m.model);
  ok(bad.length === 0, "所有条目 displayName === model",
    bad.length ? JSON.stringify(bad.map((b) => [b.displayName, b.model])) : "");
}

console.log("\n§5 端到端：模拟完整「用户选 bumen/deepseek-v4.1-flash → 桥反解」链路");
{
  const catalog = buildCatalog(cm);
  const target = cm.find((m) => m.model === "bumen/deepseek-v4.1-flash");
  ok(!!target, "清单含 bumen/deepseek-v4.1-flash");
  const uiId = Iu("openai", target.model);
  const back = jr(uiId).modelId;
  const hit = y6(back, catalog, CODEX_PROVIDER);
  ok(hit && hit.model === target.model, "y6 命中同一条目（无兜底替换）", JSON.stringify(hit));
}

console.log(`\n=== ${fail === 0 ? "全部通过" : "存在失败"} : ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
