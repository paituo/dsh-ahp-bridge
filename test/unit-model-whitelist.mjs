#!/usr/bin/env node
/**
 * 单元测试：模型池白名单化（用户问题①修复的回归守卫）
 *
 * 被测契约（inject-snippet.mjs 的 _installModelPublisher 包装层语义）：
 *   原生 base._publishModels() 会把 _models 重置为
 *     [..._capiModels, ...hydrafusion?, ..._byokModels]
 *   —— 其中 hydrafusion 与 _byokModels 对 DSH provider 属**外来项**。
 *   包装层（v6）须在跑完原生后，把 _models **整体重置为 ours（_MODEL_OURS）**，
 *   使 DSH 下拉只剩 DSH 真模型；且 ours 未就绪时**不得清空池**（安全兜底）。
 *
 * 做法：用一个「模仿 bundle provider 壳」的最小假类复刻原生 _publishModels 语义，
 *       再套用与 inject-snippet.mjs **逐字一致**的包装函数（复制其逻辑），
 *       断言：① 外来项被剔净；② ours 全在；③ ours 空时池不变；④ 幂等。
 *
 * 用法: node bridge/test/unit-model-whitelist.mjs
 */

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

// ---------------------------------------------------------------- 复刻 bundle provider 壳（原生语义）
class FakeProviderShell {
  constructor() {
    this._modelsArr = [];
    this._models = { get: () => this._modelsArr, set: (v) => { this._modelsArr = v; } };
    // 原生池的三个来源：DSH 的 capi 恒空
    this._capiModels = [];
    this._byokModels = [
      { provider: "dsh", id: "customendpoint/Bowei/Qwen3.8-Flash-AI", name: "Qwen3.8-Flash-AI" },
      { provider: "dsh", id: "customendpoint/BoweiBM/deepseek-v4.1-flash", name: "deepseek-v4.1-flash" },
    ];
    this._hydraEnabled = true;
  }
  _isHydraFusionEnabled() { return this._hydraEnabled; }
  // ★ 逐字复刻原生（agentHostMain.js:1424655，去掉 claude effort 装饰）
  _publishModels() {
    const hydra = this._isHydraFusionEnabled() && !this._capiModels.some((t) => t.id === "hydrafusion")
      ? [{ provider: this.id, id: "hydrafusion", name: "HydraFusion", supportsVision: true }]
      : [];
    this._models.set([...this._capiModels, ...hydra, ...this._byokModels], undefined);
  }
}

// ---------------------------------------------------------------- 复刻 inject-snippet.mjs 的包装层（v6）
/** 与注入源 _installModelPublisher 内的包装逻辑**逐字对齐**（只去掉了日志）。 */
function installModelPublisher(base, getOurs) {
  const _orig = base._publishModels;
  const _bound = _orig.bind(base);
  base._publishModels = function () {
    _bound();
    const _MODEL_OURS = getOurs();
    if (!_MODEL_OURS.length) return;               // 安全兜底：ours 未就绪 → 不动池
    base._models.set(_MODEL_OURS, undefined);      // 白名单：整体重置为 ours
  };
}

// ---------------------------------------------------------------- 场景
const OURS = [
  { provider: "dsh", id: '["deepseek-official","deepseek-flash"]', name: "DeepSeek-V41-Flash" },
  { provider: "dsh", id: '["deepseek-official","deepseek-v4-pro"]', name: "DeepSeek-V4-Pro" },
  { provider: "dsh", id: '["deepseek-account","deepseek-flash"]', name: "DeepSeek-V41-Flash" },
  { provider: "dsh", id: '["deepseek-account","deepseek-v4-pro"]', name: "DeepSeek-V4-Pro" },
  { provider: "dsh", id: '["lobsterai-custom-0","Qwen3.8-Flash-AI"]', name: "Qwen3.8-Flash-AI" },
  { provider: "dsh", id: '["bumen","deepseek-v4.1-flash"]', name: "deepseek-v4.1-flash" },
  { provider: "dsh", id: '["ninfer-local","bonsai2-27b"]', name: "Bonsai-2-27B-Ternary" },
];

console.log("\n=== 场景 1：原生池先污染（3 外来），包装后须只剩 ours ===\n");
{
  const base = new FakeProviderShell();
  base.id = "dsh";
  let ours = [];
  installModelPublisher(base, () => ours);

  base._publishModels();                     // ours 未就绪 → 应保持原生（3 外来）
  const pre = base._models.get().map((m) => m.id);
  ok(pre.length === 3, `ours 未就绪时池保持原生 3 条（实际 ${pre.length}）`);
  ok(pre.includes("hydrafusion"), "ours 未就绪时 hydrafusion 仍在（兜底不清空）");

  ours = OURS;                               // ours 到位
  base._publishModels();
  const post = base._models.get().map((m) => m.id);
  ok(post.length === 7, `白名单后池 = 7 条（实际 ${post.length}）`);
  ok(!post.includes("hydrafusion"), "★ hydrafusion 已被剔除");
  ok(!post.some((id) => id.startsWith("customendpoint/")), "★ 2 条 BYOK 克隆已被剔除");
  ok(OURS.every((m) => post.includes(m.id)), "7 条真 DSH 模型全部保留");
}

console.log("\n=== 场景 2：幂等（重复 publish 结果稳定）===\n");
{
  const base = new FakeProviderShell();
  base.id = "dsh";
  installModelPublisher(base, () => OURS);
  base._publishModels();
  const a = base._models.get().map((m) => m.id).join(",");
  base._publishModels();
  base._publishModels();
  const b = base._models.get().map((m) => m.id).join(",");
  ok(a === b, "多次 publish 结果完全一致（幂等）");
  ok(base._models.get().length === 7, "池恒为 7 条");
}

console.log("\n=== 场景 3：原生先跑（保证 base._capiModels 等副作用不被跳过）===\n");
{
  const base = new FakeProviderShell();
  base.id = "dsh";
  let nativeRan = 0;
  const origPublish = base._publishModels.bind(base);
  base._publishModels = function () { nativeRan++; origPublish(); };
  installModelPublisher(base, () => OURS);
  base._publishModels();
  ok(nativeRan === 1, "包装层确实先调用了原生 _publishModels（副作用保留）");
  ok(base._models.get().length === 7, "最终池为 ours");
}

console.log("\n=== 场景 4：hydraFusion 关闭时，外来项只剩 2 条 BYOK（同样须剔净）===\n");
{
  const base = new FakeProviderShell();
  base.id = "dsh";
  base._hydraEnabled = false;
  installModelPublisher(base, () => OURS);
  base._publishModels();
  const post = base._models.get().map((m) => m.id);
  ok(post.length === 7, "池仍为 7 条");
  ok(!post.some((id) => id.startsWith("customendpoint/")), "BYOK 克隆被剔除（即便 hydra 已关）");
}

console.log(`\n=== ${pass} PASS / ${fail} FAIL ===\n`);
process.exit(fail ? 1 : 0);
