/**
 * 协议翻译层：codex app-server 语义 ⇄ DSH ACP 语义。
 *
 * 设计依据（codex 模式 —— 用户确认采纳）：
 *   不是长驻双向状态同步，而是"每次要用时问一次"：
 *     - `thread/start`  → `session/new`（回执带 configOptions = 模型清单）
 *     - `thread/resume` → `session/resume`
 *     - `turn/start`    → `session/prompt`
 *     - `turn/interrupt`→ `session/cancel`
 *     - `model/list`    → 由桥侧缓存的 configOptions 合成（DSH 无独立 model/list）
 *     - `skills/list`   → 桥自行扫描同源技能目录合成（DSH 无此 RPC）
 *     - `mcpServerStatus/list` → 桥从 DSH 会话的 mcpServers 入参回读合成
 */

import { ACP_UPDATE_KIND, CODEX_NOTIFICATION, CODEX_CLIENT_REQUEST, DSH_AGENT } from "./method-names.mjs";

// ---------------------------------------------------------------- 模型

/**
 * 把 DSH 的 `configOptions` 翻译成 VS Code 期望的模型数组。
 *
 * ★ DSH 真实结构（本机 v0.2.0-rc.2 实测，session/new 回执）：
 *   configOptions: [ {
 *     id: "model", name: "Model", category: "model", type: "select",
 *     currentValue: "[\"deepseek-official\",\"deepseek-v4-flash\"]",   // ★ 值是 JSON 字符串
 *     options: [ { group:"deepseek-official", name:"DeepSeek",
 *                  options: [ { value:"[\"deepseek-official\",\"deepseek-v4-flash\"]",
 *                               name:"deepseek-v4-flash", description:"..." }, ... ] },
 *                { group:"<provider2>", name:"...", options:[...] } ]     // ★ 两级分组
 *   } ]
 *
 * VS Code 侧 `availableModels` 期望形如 "agent-host-<p>:<modelId>" 的字符串。
 *
 * @param {any} configOptions DSH session/new 回执里的 configOptions（数组）
 * @param {string} hostPrefix  形如 "agent-host-dsh"
 */
export function translateConfigOptionsToModels(configOptions, hostPrefix = "agent-host-dsh") {
  const models = [];
  const reasoning = {};
  const groups = []; // 保真：供 host 侧做分组展示

  const list = Array.isArray(configOptions)
    ? configOptions
    : Array.isArray(configOptions?.options)
      ? configOptions.options
      : Array.isArray(configOptions?.configOptions)
        ? configOptions.configOptions
        : [];

  for (const opt of list) {
    const id = opt?.id ?? opt?.configId ?? opt?.name;
    if (!id) continue;

    if (id === "model" || opt?.category === "model") {
      for (const grp of opt.options ?? []) {
        // ★ 两级：grp.group 是 provider 名，grp.options 才是模型项
        const providerName = grp?.group ?? grp?.name ?? "default";
        const items = Array.isArray(grp?.options) ? grp.options : (Array.isArray(grp) ? grp : [grp]);
        const collector = { provider: providerName, displayName: grp?.name ?? providerName, models: [] };
        for (const v of items) {
          const rawValue = typeof v === "string" ? v : (v?.value ?? v?.id);
          const name = typeof v === "string" ? v : (v?.name ?? v?.label ?? rawValue);
          if (rawValue === undefined || rawValue === null) continue;
          const modelEntry = {
            // ★ 2026-10-12 血案修复（双层前缀）：
            //   VS Code 渲染层会对 provider 报来的模型 id **自动**加一层 `<scheme>:` 前缀
            //   （`sessions.desktop.main.js@18399621`：`a = \`${e}:${r.id}\``，e="agent-host-dsh"）。
            //   若桥自己再贴一次 "agent-host-dsh:"，最终 id 变成
            //   `agent-host-dsh:agent-host-dsh:[...]`（双层）⇒ `selectModel` 的
            //   `models.find(h=>h.identifier===e)` 严格匹配失败 ⇒ 报 selection-rejected /
            //   modelUnavailable ⇒ **发送被前置拒绝**。
            //   对照组：正常工作的 copilotcli 报的是**裸 id**（`hydrafusion`、
            //   `customendpoint/...`），前缀由 VS Code 补。故桥须与之一致：报裸值。
            id: String(rawValue),                // ← 裸值（前缀交给 VS Code 渲染层补）
            name: String(name),
            rawValue,                            // DSH 侧原始值（JSON 字符串）
            provider: providerName,
            description: v?.description,
          };
          models.push(modelEntry);
          collector.models.push(modelEntry);
        }
        groups.push(collector);
      }
    } else if (/reasoning/i.test(id) || /reasoning/i.test(opt?.category ?? "")) {
      // reasoning_effort 之类
      const vals = [];
      for (const grp of opt.options ?? []) {
        const items = Array.isArray(grp?.options) ? grp.options : [grp];
        for (const v of items) vals.push(typeof v === "string" ? v : (v?.value ?? v?.id));
      }
      reasoning[id] = vals.filter((x) => x !== undefined);
    }
  }
  return { models, reasoning, groups, currentModel: extractCurrentModel(list, hostPrefix) };
}

function extractCurrentModel(list, hostPrefix) {
  for (const opt of list) {
    if ((opt?.id === "model" || opt?.category === "model") && opt.currentValue !== undefined) {
      // ★ 同步改为裸值（与上面 models[].id 保持一致；前缀由 VS Code 渲染层补）。
      //   hostPrefix 形参保留以兼容既有调用签名。
      void hostPrefix;
      return String(opt.currentValue);
    }
  }
  return undefined;
}

/**
 * 把 VS Code 的模型选择还原成 DSH 的原始 model value（形如 `["provider","model"]` 的 JSON 字符串）。
 *
 * 血案（2026-10-11，(undefined) undefined 的**真正第一诱因**）：
 *   VS Code Agents 窗口选的是 **BYOK/Custom Endpoint** 的模型，其 id 形态是
 *   `customendpoint/<vendor>/<model>`（例：`customendpoint/Bowei/Qwen3.8-Flash-AI`），
 *   **不是**桥注册的 `agent-host-dsh:<rawValue>`。
 *   旧实现只剥离 `agent-host-dsh:` 前缀，因此把 `customendpoint/Bowei/Qwen3.8-Flash-AI`
 *   **原样**传给 DSH 的 `session/set_config_option`：
 *     ⇒ DSH 报 `Invalid params: unknown model option: customendpoint/Bowei/Qwen3.8-Flash-AI`
 *     ⇒ 模型设置失败、**回落默认 provider `deepseek-official`（api.deepseek.com）**
 *     ⇒ 用 lobsterai 的 key 去打 DeepSeek 官方 ⇒ 401 `Authentication Fails...`
 *     ⇒ UI 显示 `错误: (undefined) undefined`（errorType/message 均空）。
 *
 * 修复：多路解析 ——
 *   ① `agent-host-dsh:` 前缀 → 直接剥离（原逻辑，保持兼容）；
 *   ② 已是合法 DSH value（`JSON.parse` 得 `[provider, model]` 二元数组）→ 原样返回；
 *   ③ `customendpoint/<vendor>/<model>` 或纯 `<model>` → 用**已缓存的模型清单**
 *      （`availableModels`，每项含 name/provider/rawValue）按「完整串 / model 名 / provider+名」反查；
 *   ④ 都失败 → 返回 undefined，让调用方**明确报错**（绝不静默回落默认 provider）。
 *
 * @param {string} modelString VS Code 传来的模型 id
 * @param {string} hostPrefix  形如 "agent-host-dsh"
 * @param {Array<{id:string,name:string,rawValue:string,provider:string}>} [availableModels] 桥缓存的模型清单
 * @returns {{value:string, matchedBy:string}|undefined}
 */
/**
 * 把 DSH 扩展方法 `_deepseek/models` 的能力元数据合并进模型条目。
 *
 * ★ 为什么需要这一步（2026-10-15 定案）：
 *   AHP 协议 `SessionModelInfo` **有位置**承载 `maxContextWindow /
 *   maxPromptTokens / maxOutputTokens / supportsVision / configSchema`，
 *   VS Code 的 `Vfe.provideLanguageModelChatInfo` 会逐字段读它们，
 *   但 ACP 标准的 `configOptions.model` 只携带 value/name/description
 *   ⇒ DSH 这条自定义通道的模型属性一直是空的（maxInputTokens=0、vision=false）。
 *   桥在这里补上「能力数据的搬运」，注入层再透传给 `_models`。
 *
 * 字段名映射（DSH 能力 → AHP `SessionModelInfo`）：
 *   contextWindow        → maxContextWindow
 *   maxOutputTokens      → maxOutputTokens
 *   contextWindow-maxOut → maxPromptTokens    （对齐 Vfe 的推导式）
 *   supportsVision       → supportsVision
 *   reasoningEfforts     → supportedReasoningEfforts  （VS Code 据此自动生成思考等级 configSchema）
 *   defaultReasoningEffort → defaultReasoningEffort
 *
 * 匹配键为 `${provider}\u0000${modelId}`。**未知能力不写字段**（保持 undefined），
 * 让 VS Code 用它自己的回落逻辑，而不是用假值污染。
 *
 * @param {Array} models 已翻译的模型条目（含 provider / rawValue）
 * @param {Array|null} capabilityTable `_deepseek/models` 返回的 models 数组，或 null
 * @returns {number} 被合并（命中能力）的模型数
 */
export function mergeModelCapabilities(models, capabilityTable) {
  if (!Array.isArray(models) || !Array.isArray(capabilityTable) || capabilityTable.length === 0) return 0;
  const byKey = new Map();
  for (const cap of capabilityTable) {
    if (!cap || typeof cap.provider !== "string" || typeof cap.id !== "string") continue;
    byKey.set(`${cap.provider}\u0000${cap.id}`, cap);
  }
  let hit = 0;
  for (const m of models) {
    if (!m) continue;
    // 模型条目的 rawValue 是 DSH 侧的 model value（形如 '["provider","model"]' 的 JSON 字符串）。
    const pair = parseModelPair(m.rawValue);
    if (!pair) continue;
    const cap = byKey.get(`${pair.provider}\u0000${pair.model}`);
    if (!cap) continue;
    let touched = false;

    if (typeof cap.contextWindow === "number" && cap.contextWindow > 0) {
      m.maxContextWindow = cap.contextWindow;
      touched = true;
    }
    if (typeof cap.maxOutputTokens === "number" && cap.maxOutputTokens > 0) {
      m.maxOutputTokens = cap.maxOutputTokens;
      touched = true;
    }
    if (typeof m.maxContextWindow === "number") {
      const derived = Math.max(0, m.maxContextWindow - (typeof m.maxOutputTokens === "number" ? m.maxOutputTokens : 0));
      if (derived > 0) m.maxPromptTokens = derived;
    }
    if (typeof cap.supportsVision === "boolean") {
      m.supportsVision = cap.supportsVision;
      touched = true;
    }
    if (Array.isArray(cap.reasoningEfforts) && cap.reasoningEfforts.length > 0) {
      m.supportedReasoningEfforts = cap.reasoningEfforts.map((e) => e.id);
      if (typeof cap.defaultReasoningEffort === "string") {
        m.defaultReasoningEffort = cap.defaultReasoningEffort;
      }
      touched = true;
    }
    // 保真：能力显示名（供诊断/未来 UI 使用，VS Code 不消费）
    if (Array.isArray(cap.reasoningEfforts) && cap.reasoningEfforts.length > 0) {
      m.reasoningEffortLabels = Object.fromEntries(cap.reasoningEfforts.map((e) => [e.id, e.name]));
    }
    if (touched) hit++;
  }
  return hit;
}

/**
 * ★★★ V2 补丁 M6（2026-10-16）：把桥内部模型条目重塑为**官方 `Model` 契约**。
 *
 * 为什么必须做在 `model/list` 边界上、而不是改 `translateConfigOptionsToModels`：
 *   内部条目的字段（`id` = 裸 rawValue、`name`、`rawValue`、`reasoningEfforts` 字符串数组…）
 *   仍被**别处**消费，不能动：
 *     · 注入层 `_toProviderModel(x)` 读 `x.id / x.name / x.provider / x.maxContextWindow /
 *       maxOutputTokens / maxPromptTokens / supportsVision / reasoningEffortLabels /
 *       defaultReasoningEffort / supportedReasoningEfforts`；
 *     · `translateModelSelectionToDsh` 反查 `availableModels` 用 `id / name / rawValue / provider`；
 *     · `mergeModelCapabilities` 用 `rawValue / provider / maxContextWindow / maxOutputTokens`。
 *   ⇒ 重塑只发生在 `model/list` 回执装配处，内部管线（thread/start、注入层、选择反解）零改动。
 *
 * 血案（复测实测）：桥报出的元素是 `{id:"[\"deepseek-official\",\"deepseek-flash\"]", name:"deepseek-flash"}`
 *   —— `model` / `displayName` 全为 undefined。而官方 `v2/Model.ts` 要求
 *   `{ id, model, upgrade, upgradeInfo, availabilityNux, displayName, description,
 *      modelSpecialty, hidden, supportedReasoningEfforts, defaultReasoningEffort,
 *      inputModalities, supportsPersonality, multiAgentVersion, additionalSpeedTiers,
 *      serviceTiers, defaultServiceTier, availableAccessPrograms, isDefault }`
 *   且 VS Code `codexAgent.ts` 用 `toCodexModelSelectionId(modelProvider, model.model)`
 *   生成 identifier、用 `model.displayName` 做展示名 ⇒ 形状不符即下拉空白/选中失败。
 *
 * 字段映射（桥内部 → 官方 Model）：
 *   id                     → id            （裸 rawValue；会话回写时仍用 `model` 反解）
 *   parseModelPair.rawValue→ model         （**DSH 侧模型名**，如 "deepseek-flash"；
 *                                           官方语义上 `model` 才是「真正模型名」，`id` 是选择项 id）
 *   name ?? model          → displayName
 *   description ?? ""      → description
 *   supportedReasoningEfforts(string[]) → supportedReasoningEfforts: [{reasoningEffort, description}]
 *   defaultReasoningEffort → defaultReasoningEffort
 *   supportsVision         → inputModalities: ["text",  ...(vision ? ["image"] : [])]
 *
 * @param {Array} models 桥内部模型条目
 * @returns {Array} 官方 `Model` 形态数组（元素保留 `rawValue/provider` 供桥侧诊断，属无害扩展字段）
 */
export function toCodexModels(models) {
  if (!Array.isArray(models)) return [];
  return models.map((m) => {
    const pair = parseModelPair(m?.rawValue);
    // ★★★★ 模型歧义修复 v2（2026-10-16 二次定案）—— v1 修错了位置，此处是 v1 的血案复盘。
    //
    // 【必须同时满足的两条官方契约】（缺一即「选 A 跑 B」，二者是**独立**缺陷）
    //
    //  契约① 编码可区分：官方 `codexAgent.ts` 用
    //     `toCodexModelSelectionId(modelProvider, model.model)`
    //     编 id，其中 `modelProvider` 取自 `config/read`（**全局单值**，桥固定 "openai"）
    //     ⇒ **VS Code 侧对 provider 零区分度**。若 `model` 只给裸名（"deepseek-flash"），
    //     而 DSH 清单里同时有 `[deepseek-official|deepseek-account, deepseek-flash]`，
    //     两者在 UI 侧**不可区分** ⇒ 用户选谁都只能解析到首项。
    //
    //  契约② 选择可回验：官方 `create_session`/`create_chat` 的模型参数要过
    //     `y6(r, catalog, provider)` 校验（`agentHostMain.js`）：
    //       `let n = t.filter(s => s.id === r);`            // 先按 catalog 的 **id** 比
    //       `let o = n.length > 0 ? n : t.filter(s => s.name === r);`  // 再按 **name** 比
    //       `if (o.length === 0) throw "model must match an available model id or name";`
    //     其中 `catalog[].id` = `Iu("openai", model.model)`（**由 `model` 字段决定**）
    //        `catalog[].name` = `model.displayName`（**由 `displayName` 决定**）
    //     而 UI 回传的 `r` = `jr(id).modelId` = **`model` 字段原文**。
    //     ⇒ **`model` 字段必须同时出现在 `id`（必然，因 id 由它拼）与 `name` 里**，
    //       否则 `y6` 两条路全落空 ⇒ 抛错 ⇒ VS Code 走 `_resolveModelFromCatalog` 兜底
    //       ⇒ 取"同 provider 首项" ⇒ 用户选的模型被**静默替换**。
    //
    // 【v1 血案（我上一轮改错的地方）】
    //   v1 只把 `model` 改成 `provider/名`（满足了契约①），
    //   却把 `displayName` 留成干净人类名（+ 仅重名时附 provider 后缀）⇒ **违反契约②**：
    //     `y6("bumen/deepseek-v4.1-flash")`：
    //       by id  → catalog id = `@provider=openai:bumen%2Fdeepseek-v4.1-flash`
    //                ≠ `bumen/deepseek-v4.1-flash`                      ❌
    //       by name→ name = `deepseek-v4.1-flash` ≠ `bumen/deepseek-v4.1-flash` ❌
    //     ⇒ 两条路全落空 ⇒ 抛错 ⇒ VS Code 兜底取同 provider 首项
    //     ⇒ `deepseek-official/deepseek-flash` ⇒ 打 api.deepseek.com ⇒ 401
    //     ⇒ DSH 侧该会话仍持 pinned 默认 `lobsterai-custom-0`（jxbw）
    //     ⇒ 用户实际看到 **403 `access_denied / 您的 IP 不在令牌允许访问的列表中`**。
    //   （★ 这也是"日志说下发 deepseek-official，报错却是 jxbw"的原因 ——
    //     报错来自**另一条并发会话**的 pinned 默认，不是同一条链。）
    //
    // 【v2 修法】`model` 与 `displayName` **同源**，都取 `<provider>/<模型名>`：
    //   ⇒ `y6` 的 by-name 路必然命中（因 `name === model`）；by-id 路也命中（因 id 由 model 拼）；
    //   ⇒ UI 下拉同时获得**可区分性**（同名项显示为 `deepseek-official/deepseek-flash`
    //     与 `deepseek-account/deepseek-flash`）—— 这正是用户需要的。
    //   ⇒ 桥侧 `resolveDshModelValue` 按 `provider/名` 精确反解（③-pre），零歧义。
    //
    // 【为什么不改 id】`id` 是 VS Code 自主装配的（`Iu(s, g.model)`），桥给的 `id` 会被覆盖；
    //   桥只能通过 `model` 影响它 —— 故 `model` 是唯一的杠杆点。
    const rawName = pair?.model ?? String(m?.name ?? m?.id ?? "");
    const rawProvider = pair?.provider ?? m?.provider ?? "";
    const modelName = rawProvider ? `${rawProvider}/${rawName}` : rawName;
    const id = String(m?.id ?? m?.rawValue ?? modelName);
    const efforts = Array.isArray(m?.supportedReasoningEfforts)
      ? m.supportedReasoningEfforts.filter((e) => typeof e === "string")
      : [];
    const labels = (m?.reasoningEffortLabels && typeof m.reasoningEffortLabels === "object") ? m.reasoningEffortLabels : {};
    const defaultEffort = (typeof m?.defaultReasoningEffort === "string" && efforts.includes(m.defaultReasoningEffort))
      ? m.defaultReasoningEffort
      : (efforts.includes("medium") ? "medium" : (efforts[0] ?? "medium"));
    const modalities = ["text"];
    if (m?.supportsVision === true) modalities.push("image");

    return {
      id,
      model: modelName,
      upgrade: null,
      upgradeInfo: null,
      availabilityNux: null,
      // ★★★★ displayName 必须与 `model` 同源（见上方 v2 定案的「契约②」）。
      //   官方 `y6()` 的 by-name 校验比的就是本字段（`catalog[].name = model.displayName`），
      //   而 UI 回传的待校验值 = `model` 字段原文。二者不等 ⇒ 校验失败 ⇒ 模型被静默替换。
      //   血案：v1 让 displayName = `deepseek-flash (deepseek-official)`（干净名 + 后缀），
      //   而 model = `bumen/deepseek-v4.1-flash` 之类 ⇒ 永不相等 ⇒ 全部条目选不中。
      //   ⇒ 统一为 `provider/名`：既过校验，又顺带解决 UI 侧同名项不可辨的问题。
      displayName: modelName,
      description: String(m?.description ?? ""),
      modelSpecialty: null,
      hidden: false,
      supportedReasoningEfforts: efforts.length
        ? efforts.map((e) => ({ reasoningEffort: e, description: labels[e] ?? e }))
        : [{ reasoningEffort: "medium", description: "medium" }],
      defaultReasoningEffort: defaultEffort,
      inputModalities: modalities,
      supportsPersonality: false,
      multiAgentVersion: null,
      additionalSpeedTiers: [],
      serviceTiers: [],
      defaultServiceTier: null,
      availableAccessPrograms: null,
      isDefault: false,
      // —— 桥侧扩展（VS Code 的 _publishAgentInfos 只逐字段挑选上面的官方字段，
      //    这些额外字段不会被消费，保留供诊断/反解链使用）——
      ...(m?.rawValue !== undefined ? { rawValue: m.rawValue } : {}),
      ...(m?.provider !== undefined ? { provider: m.provider } : {}),
    };
  });
}

/** 解析 DSH 模型 value（`'["provider","model"]'` JSON 字符串）为 {provider, model}。 */
function parseModelPair(rawValue) {
  if (typeof rawValue !== "string") return null;
  try {
    const arr = JSON.parse(rawValue);
    if (Array.isArray(arr) && arr.length >= 2) {
      return { provider: String(arr[0]), model: String(arr[1]) };
    }
  } catch { /* 非 JSON ⇒ 不是本形态 */ }
  return null;
}

export function translateModelSelectionToDsh(modelString, hostPrefix = "agent-host-dsh", availableModels = []) {  if (typeof modelString !== "string" || !modelString) return undefined;

  // ① 剥离 `agent-host-dsh:` 前缀（**兼容新旧两种形态**）。
  //    ★ 2026-10-12 双层前缀修复后：
  //      - 新形态：VS Code 渲染层补一层 → `agent-host-dsh:["bumen","..."]`（单层），剥 1 层即得裸值；
  //      - 旧形态：历史遗留/缓存的 `agent-host-dsh:agent-host-dsh:[...]`（双层），需剥 2 层；
  //      - 裸值：直接命中 ② 分支。
  const p = `${hostPrefix}:`;
  let candidate = modelString;
  // 循环剥离（最多 2 层），防止历史双层值残留
  for (let i = 0; i < 2 && candidate.startsWith(p); i++) {
    candidate = candidate.slice(p.length);
  }

  // ② 已是合法 DSH value：["provider","model"] 二元数组
  const isDshValue = (s) => {
    if (typeof s !== "string" || !s.trim().startsWith("[")) return false;
    try {
      const a = JSON.parse(s);
      return Array.isArray(a) && a.length === 2 && typeof a[0] === "string" && typeof a[1] === "string";
    } catch { return false; }
  };
  if (isDshValue(candidate)) return { value: candidate, matchedBy: "dsh-value" };

  // ③ 按模型清单反查（先精确，再按名，再到末段名）
  const list = Array.isArray(availableModels) ? availableModels : [];
  const byFull = (s) => list.find((m) => m && (m.id === s || m.rawValue === s));
  const byName = (s) => list.find((m) => m && (m.name === s || m.rawValue === s || m.id === s));

  // ★★★ ③-pre 精确反解 `<provider>/<模型名>`（2026-10-16 模型歧义修复）
  //   必须**优先于**下面的「末段名」解析：否则 `deepseek-official/deepseek-flash`
  //   会被 `byName("deepseek-flash")` 抢先命中清单首项（可能是 deepseek-account），
  //   即「用 provider 段区分了别名，却又被末段名解析抹掉」——修了等于没修。
  if (candidate.includes("/") && !candidate.startsWith("customendpoint/")) {
    const idx = candidate.indexOf("/");
    const p = candidate.slice(0, idx);
    const nm = candidate.slice(idx + 1);
    const exact = list.find((m) => m && m.provider === p && (m.name === nm || m.id === nm))
      ?? list.find((m) => m && m.rawValue === JSON.stringify([p, nm]));
    if (exact?.rawValue) return { value: exact.rawValue, matchedBy: "resolved-by-provider-exact" };
    if (exact?.provider && exact?.name) return { value: JSON.stringify([exact.provider, exact.name]), matchedBy: "resolved-by-provider-exact" };
    // provider 段合法但清单未收录 ⇒ 直接构造（DSH 侧会校验并给出明确错误）
    if (p && nm) return { value: JSON.stringify([p, nm]), matchedBy: "provider-slash-passthrough" };
  }

  let hit = byFull(candidate) ?? byFull(modelString);
  if (!hit && candidate.includes("/")) {
    const segs = candidate.split("/").filter(Boolean);
    const last = segs[segs.length - 1];
    const vendorModel = segs.slice(-2).join("/");            // "<vendor>/<model>"
    hit = byName(last) ?? list.find((m) => m && (m.name === last))
       ?? list.find((m) => m && m.provider && candidate.startsWith(`customendpoint/${m.provider}/`) && m.name === last)
       ?? byName(vendorModel);
  }
  if (!hit) hit = byName(candidate);

  if (hit?.rawValue) return { value: hit.rawValue, matchedBy: "resolved-by-name" };
  if (hit?.provider && hit?.name) return { value: JSON.stringify([hit.provider, hit.name]), matchedBy: "resolved-by-provider-name" };

  // ④ 无法识别 —— 交调用方报错
  return undefined;
}

// ---------------------------------------------------------------- 技能

/**
 * 桥自行实现的 `skills/list` —— DSH ACP 没有这个 RPC，
 * 所以由桥扫描与 VS Code 同源的技能目录后按 VS Code 期望结构返回。
 *
 * 返回结构参照 VS Code 使用侧（`_fetchSkills` 消费 `n.data[].skills[]`）：
 *   { data: [ { cwd, skills: [ { name, description, scope, uri, ... } ] } ] }
 */
export function buildSkillsListResult(cwds, skillFiles /* [{cwd, name, description, scope, path}] */) {
  const byCwd = new Map();
  for (const cwd of cwds ?? []) byCwd.set(cwd, []);
  for (const f of skillFiles ?? []) {
    if (!byCwd.has(f.cwd)) byCwd.set(f.cwd, []);
    byCwd.get(f.cwd).push({
      name: f.name,
      // ★★★ 契约修正（2026-10-16，**本回合根因**）：`SkillMetadata.required` 含 `path`。
      //   此前只给 `uri` ⇒ VS Code `URI.file(skill.path)` 收到 undefined
      //   ⇒ Windows 分支 `path.replace(/\\/g,"/")` 抛 `Cannot read properties of undefined (reading 'replace')`。
      path: f.path ? String(f.path) : undefined,
      description: f.description ?? "",
      scope: f.scope ?? "user",
      enabled: f.enabled !== false,
      uri: f.path ? `file://${String(f.path).replace(/\\/g, "/")}` : undefined,
      disableModelInvocation: false,
      disableUserInvocation: false,
    });
  }
  // ★★★ 契约统一（2026-10-16）：权威 `SkillsListEntry` required = `["cwd","errors","skills"]`
  //   （schema/v2/SkillsListResponse.json）—— `errors` 此前遗漏 ⇒ 上游若遍历 `entry.errors` 即崩。
  return { data: [...byCwd.entries()].map(([cwd, skills]) => ({ cwd, skills, errors: [] })) };
}

/**
 * ★★★ 构造 codex `hooks/list` 应答（2026-10-16 新增）。
 *
 * 【为什么必须实现】
 *   权威 `HooksListEntry` required = `["cwd","errors","hooks","warnings"]`
 *   （schema/v2/HooksListResponse.json）。DSH 侧无 hook 概念，桥此前兜底返回 `{data:[]}`
 *   ⇒ 空数组本身合法，但**一旦 VS Code 拿到空 data 就会走"无 hook 容器"分支**，
 *   与"每个 cwd 都应有条目"的官方语义不符；且 `_buildSessionHookTrustState` 会读
 *   `data[].errors`、`data[].hooks` ⇒ 条目缺失字段时抛 `Cannot read properties of undefined`。
 *   修：**对每个请求的 cwd 恒返回一条合法空条目**（语义 = "该目录无 hook"）。
 *
 * @param {string[]} cwds
 */
export function buildHooksListResult(cwds) {
  const list = Array.isArray(cwds) && cwds.length ? cwds : [];
  return {
    data: list.map((cwd) => ({ cwd, hooks: [], errors: [], warnings: [] })),
  };
}

// ---------------------------------------------------------------- 会话生命周期

/** codex `thread/start` 参数 → DSH `session/new` 参数 */
export function threadStartToSessionNew(params) {
  // ★★★ 模型贯通（2026-10-16，修「Model name was not received」类报错）。
  //
  // 【证据】VS Code `codexAgent.ts:5078-5079` / `5705-5706` 的 `thread/start` 请求体
  //   明确携带两个字段（一个都不少）：
  //     `model: resolvedModel.modelId`
  //     `modelProvider: resolvedModel.modelProvider`
  //   其中 `parseCodexModelSelection()` 把模型选择串拆成这两半 —— 因为我们冒名 codex
  //   用的是官方 provider 名，所以 `modelProvider` 恒为 `"openai"`。
  //
  // 【旧缺陷】本函数此前**只取 cwd/mcpServers**，把 `model` / `modelProvider` 全丢了
  //   ⇒ DSH `session/new` 拿不到模型 ⇒ 只能用 profile 默认 ⇒ 用户选了模型却"没生效"。
  //
  // 【修法】把 model/provider 透传为 ACP `session/new` 可消费的补充字段。
  //   ★ 注意：ACP 标准 `session/new` 只认 `{cwd, mcpServers}`；模型应经
  //     `session/set_config_option(configId="model", value=["provider","model"])` 设置。
  //     故这里**同时**给出：① 原始字段（供桥在 thread/start 后补发 set_config_option）；
  //     ② 尽力而为的 `model` 原样（备将来 ACP 扩展）。
  const modelId = params?.model ?? params?.settings?.model ?? undefined;
  const modelProvider = params?.modelProvider ?? undefined;
  return {
    cwd: params?.cwd ?? params?.workingDirectory ?? process.cwd(),
    mcpServers: params?.mcpServers ?? [],
    // —— 桥内部透传（非 ACP 标准字段；由 bridge.mjs 在 session/new 之后消费）——
    ...(modelId ? { __model: String(modelId) } : {}),
    ...(modelProvider ? { __modelProvider: String(modelProvider) } : {}),
  };
}

/**
 * ★ 从 `thread/start` 的 `model` + `modelProvider` 还原出 DSH 的模型 value。
 *
 * 【为什么需要】VS Code 传的是**拆开的两半**（`modelId` + `modelProvider`），
 *   而 DSH 要的是 `["provider","model"]` 二元数组字符串。桥必须在会话创建时
 *   把两半合回一体，否则模型设置永远落不下去。
 *
 * 【判定顺序】
 *   ① `modelId` 本身已是 DSH value（`["p","m"]`）⇒ 直接用；
 *   ② 能按模型清单反查到 `rawValue` ⇒ 用清单值（最可靠）；
 *   ③ `modelId` 含 `/`（如 `customendpoint/vendor/model`）⇒ 末两段拼；
 *   ④ 兜底：`[modelProvider, modelId]`（provider 来自 VS Code 拆解，通常为 "openai"）。
 *
 * @returns {string|undefined} DSH model value（JSON 字符串），无法判定时 undefined
 */
export function resolveDshModelValue(modelId, modelProvider, availableModels = []) {
  const idRaw = typeof modelId === "string" ? modelId.trim() : "";
  if (!idRaw) return undefined;

  // ① 已是 DSH value
  try {
    const a = JSON.parse(idRaw);
    if (Array.isArray(a) && a.length === 2 && a.every((x) => typeof x === "string")) return idRaw;
  } catch { /* 不是 JSON，继续 */ }

  const list = Array.isArray(availableModels) ? availableModels : [];

  // ★★★ ② 精确反解 `<provider>/<模型名>`（2026-10-16 模型歧义修复的正解路径）
  //   桥的 `toCodexModels` 现在把 `model` 编码成 `provider/模型名`，VS Code 原样回传
  //   ⇒ 这里按 **provider + 模型名双键** 精确命中，**彻底消除同名歧义**。
  //   血案：此前只按裸模型名反查，`deepseek-flash` 有 2~3 条同名项 ⇒ 取首项 ⇒ 猜错 provider
  //   ⇒ 指向 api.deepseek.com ⇒ 401 ⇒ 静默回落 pinned 默认（用户选了却不生效）。
  if (idRaw.includes("/")) {
    const idx = idRaw.indexOf("/");
    const p = idRaw.slice(0, idx);
    const nm = idRaw.slice(idx + 1);
    const hit2 = list.find((m) => m && m.provider === p && (m.name === nm || m.id === nm))
      ?? list.find((m) => m && m.provider === p && m.rawValue === JSON.stringify([p, nm]));
    if (hit2?.rawValue) return hit2.rawValue;
    if (hit2?.provider && hit2?.name) return JSON.stringify([hit2.provider, hit2.name]);
    // provider 段合法但清单未收录该组合 ⇒ 仍可用 `[provider, 模型名]`（DSH 侧自会校验）
    return JSON.stringify([p, nm]);
  }

  // ③ ★ 歧义预检（2026-10-16）：裸名在清单里命中多条 ⇒ **直接拒绝**，绝不猜首项。
  //   血案：`deepseek-flash` 有 `deepseek-official` / `deepseek-account` 两条同名项，
  //   旧逻辑调 `translateModelSelectionToDsh` 命中首项 ⇒ 落到官方 provider ⇒ 401 ⇒ 静默回落。
  //   「宁可报错让用户知道模型没设上，也不要静默用错模型跑」。
  const bareHit = list.filter((m) => m && (m.name === idRaw || m.id === idRaw));
  if (bareHit.length > 1) return undefined;

  // ④ 按清单反查（沿用 translateModelSelectionToDsh 的解析力，去掉 host 前缀依赖）
  const hit = translateModelSelectionToDsh(idRaw, "agent-host-dsh", list);
  if (hit?.value) return hit.value;

  // ⑤ vendor/model 形态（历史兼容；已被 ② 覆盖，保留兜底）
  if (idRaw.includes("/")) {
    const segs = idRaw.split("/").filter(Boolean);
    if (segs.length >= 2) return JSON.stringify([segs[segs.length - 2], segs[segs.length - 1]]);
  }

  // ⑥ 唯一匹配才允许裸名反解（歧义已在 ③ 拦截）
  const byName = list.filter((m) => m && (m.name === idRaw || m.id === idRaw || m.rawValue === idRaw));
  if (byName.length === 1 && byName[0].rawValue) return byName[0].rawValue;

  // ⑦ 兜底：用 VS Code 拆出的 provider 与之配对
  //   ★ 注意 provider 为 "openai" 时**不能**直接当 DSH provider 用（M6 补丁使该字段恒为
  //     "openai"，是 VS Code 的占位值而非真实 provider），故仅作最后兜底。
  if (modelProvider && modelProvider !== "openai") {
    return JSON.stringify([String(modelProvider), idRaw]);
  }
  return undefined;
}

/**
 * ★★★ 统一构造 codex `Thread` 对象（**唯一真源**，2026-10-16 定案）。
 *
 * 【为什么必须统一】
 *   VS Code 对 `thread/start`、`thread/resume`、`thread/read`、`thread/list`、`thread/fork`
 *   的应答**全部消费同一套 `Thread` 结构**（实证反编译：`P.thread.id`、`.thread.status.type`、
 *   `.thread.cwd`、`.thread.historyMode`、`.thread.turns`）。
 *   而权威 JSON Schema（openai/codex `app-server-protocol/schema/json/v2/Thread*Response.json`）
 *   声明 `Thread` 有 **13 个 required**：
 *     cliVersion, createdAt, cwd, ephemeral, id, modelProvider, preview,
 *     projectId, sessionId, source, status, turns, updatedAt
 *   ⇒ 任何一处漏字段，上游就可能读到 `undefined.xxx` 而抛
 *     `Cannot read properties of undefined (reading '<field>')`。
 *
 * 【血案】桥此前 `thread/start` 返回**扁平** `{threadId,sessionId,models,...}`（无 `thread` 包装），
 *   ⇒ VS Code `_materialize()` 执行 `k = P.thread.id` ⇒ `P.thread` 为 undefined
 *   ⇒ 抛 `(CodexMaterializeFailed) Cannot read properties of undefined (reading 'id')`，
 *   会话**永远建不起来**（prewarm + 发消息两条路径全挂）。
 *
 * @param {string} threadId         会话 id（= DSH sessionId）
 * @param {{cwd?:string, model?:string, modelProvider?:string, turns?:Array,
 *          historyMode?:string, status?:string, name?:string, ephemeral?:boolean}} [meta]
 */
export function toCodexThread(threadId, meta = {}) {
  // ★★ 时间单位铁律（权威 schema 明文）：
  //    - `Thread.createdAt` / `updatedAt`：描述为 "Unix timestamp (in **seconds**)" ⇒ 用**秒**
  //    - `Turn.startedAt` / `completedAt`：描述同为 "Unix timestamp (in **seconds**)" ⇒ 也用**秒**
  //    - `Turn.durationMs`：毫秒（字段名即单位）
  //    ⇒ 三者中只有 durationMs 是毫秒。此前误把 Thread 时间戳当毫秒写 (*1000) 触发回归，已纠正。
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    // —— 13 个 required（一个都不能少）——
    id: String(threadId ?? ""),
    sessionId: String(threadId ?? ""),
    cliVersion: meta.cliVersion ?? "0.0.0-dsh-bridge",   // 桥自称版本（无官方 CLI 语义）
    createdAt: meta.createdAt ?? nowSec,
    updatedAt: meta.updatedAt ?? nowSec,
    cwd: meta.cwd ?? undefined,                          // AbsolutePathBuf；None ⇒ 不输出
    ephemeral: meta.ephemeral === true,
    modelProvider: meta.modelProvider ?? "openai",
    preview: meta.preview ?? "",
    projectId: meta.projectId ?? null,
    source: meta.source ?? "vscode",                     // SessionSource 枚举：cli|vscode|exec|appServer|unknown
    status: { type: meta.status === "active" ? "active" : "idle" },  // ThreadStatus
    turns: Array.isArray(meta.turns) ? meta.turns : [],
    // —— 可选字段 ——
    model: meta.model ?? null,
    name: meta.name ?? null,
    historyMode: meta.historyMode ?? "legacy",             // ★ 非 paginated ⇒ 上游一次取全量
    ...(meta.gitInfo !== undefined ? { gitInfo: meta.gitInfo } : {}),
    ...(meta.parentThreadId !== undefined ? { parentThreadId: meta.parentThreadId } : {}),
  };
}

/** DSH `session/new` 回执 → codex `thread/start` 回执 */
export function sessionNewToThreadStart(sessionRes, hostPrefix = "agent-host-dsh") {
  const { models, reasoning, groups, currentModel } = translateConfigOptionsToModels(sessionRes?.configOptions, hostPrefix);
  const sessionId = sessionRes?.sessionId;
  return {
    // ★★★ 权威契约（ThreadStartResponse）required：
    //     approvalPolicy, approvalsReviewer, cwd, model, modelProvider, sandbox, thread
    //   —— 一个都不能少，否则 VS Code 读 `res.thread.id` 即崩。
    thread: toCodexThread(sessionId, {
      cwd: sessionRes?.cwd,
      model: sessionRes?.model ?? currentModel ?? null,
      modelProvider: sessionRes?.modelProvider ?? "openai",
      turns: sessionRes?.turns,
      status: sessionRes?.status,
    }),
    cwd: sessionRes?.cwd,
    model: sessionRes?.model ?? currentModel ?? null,
    modelProvider: sessionRes?.modelProvider ?? "openai",
    approvalPolicy: sessionRes?.approvalPolicy ?? "on-request",   // AskForApproval: untrusted|on-request|never
    approvalsReviewer: sessionRes?.approvalsReviewer ?? "user",   // ApprovalsReviewer: user|auto_review|guardian_subagent
    sandbox: sessionRes?.sandbox ?? { type: "workspaceWrite" },   // SandboxPolicy: dangerFullAccess|readOnly|externalSandbox|workspaceWrite
    // —— 以下为桥内部管线依赖字段（保持向后兼容，勿删）——
    threadId: sessionId,
    sessionId,
    models,
    groups,
    ...(currentModel ? { currentModel } : {}),
    ...(Object.keys(reasoning).length ? { reasoningOptions: reasoning } : {}),
    configOptions: sessionRes?.configOptions,
  };
}

/**
 * 构造 codex `thread/read` 回执。
 *
 * ★★★ 血案（2026-10-11 02:40，真机报错 `Session was never created on the backend`）：
 *   VS Code 恢复历史 chat 时会调 `thread/read`（实证调用方：agentHostMain.js
 *   `_prepareChat`/`_doReadSession` → `client.request("thread/read",{threadId,includeTurns})`），
 *   并消费 `res.thread.{id,status,cwd,historyMode,turns}`：
 *     - `res.thread.status.type` 必须 ∈ {idle, active}（`_prepareChat` 据此决定是否 resume）；
 *     - `historyMode === "paginated"` 才会走游标分页，否则一次 `includeTurns:true` 取全量；
 *     - `thread.id` 必须等于请求的 threadId。
 *   桥此前**只声明未实现** thread/read ⇒ 兜底返回 MethodNotFound ⇒ 上游 `p` 为空 ⇒
 *   抛 `Session was never created on the backend: <sid>`（启动时刷屏几十次）。
 *   修：对**未知 session 也返回合法空 thread**（status=idle、turns=[]），让上游优雅降级
 *   （等同"会话还在但暂无轮次"），而不是把它当致命错误。
 *
 * @param {string} threadId
 * @param {{cwd?:string, turns?:Array, historyMode?:string, status?:string, name?:string}} [meta]
 */
export function threadReadResult(threadId, meta = {}) {
  return {
    thread: toCodexThread(threadId, {
      cwd: meta.cwd,
      model: meta.model,
      modelProvider: meta.modelProvider,
      turns: meta.turns,
      historyMode: meta.historyMode ?? "legacy",   // 非 paginated ⇒ 上游一次取全量
      status: meta.status,
      name: meta.name,
      source: meta.source,
      preview: meta.preview,
    }),
  };
}

/** codex `turn/start` 参数 → DSH `session/prompt` 参数 */
export function turnStartToPrompt(params) {
  const prompt = [];
  const input = params?.input ?? params?.items ?? params?.prompt;
  if (typeof input === "string") {
    prompt.push({ type: "text", text: input });
  } else if (Array.isArray(input)) {
    for (const it of input) {
      if (typeof it === "string") prompt.push({ type: "text", text: it });
      else if (it?.type === "text" || it?.type === "inputText") prompt.push({ type: "text", text: it.text ?? "" });
      else if (it?.type === "image" || it?.type === "inputImage") prompt.push({ type: "image", data: it.data ?? it.imageUrl, mimeType: it.mimeType });
    }
  }
  return { sessionId: params?.threadId ?? params?.sessionId, prompt,
           // ★ 2026-10-16：透传注入层带来的 VS Code turnId（renderer 的 requestId）。
           //   renderer 用 _clientDispatchedTurnIds 判定「是否服务端主动发起」，其键就是该 requestId。
           //   若 turn/started 的 turn.id 与它不一致 ⇒ renderer 认不出 ⇒ 走 server-initiated 分支
           //   ⇒ 既产生第二条用户消息，又因读 O.message.text 而崩溃。故必须原样贯通。
           vscodeTurnId: params?.vscodeTurnId ?? null,
           // ★★★ 2026-10-16 血案修复：「审核方式 / 交互方式 / 权限」三轴随 turn/start 下发。
           //   官方 `codexAgent.ts::_turnStartOptions()` 把 approvalPolicy / permissions /
           //   approvalsReviewer / collaborationMode 放在 turn/start 参数里（**不走
           //   permissions/setMode**，实测后者调用数=0）。旧版桥只取 sessionId/prompt
           //   ⇒ 三轴全丢 ⇒ 永远停在 DSH pinned 默认档。
           //   修：原样带出这四个字段，由调用方（bridge.mjs turn/start）解析并落 DSH。
           permissionAxes: {
             approvalPolicy: params?.approvalPolicy ?? null,
             permissions: params?.permissions ?? null,
             approvalsReviewer: params?.approvalsReviewer ?? null,
             collaborationMode: params?.collaborationMode ?? null,
             sandboxMode: params?.sandboxMode ?? params?.sandbox ?? null,
           } };
}

// ---------------------------------------------------------------- 事件（DSH → VS Code）

/**
 * 把一个 ACP `session/update` 展开成若干条 codex 通知。
 * 这是桥翻译层最核心的一段：1 条 ACP update → N 条 VS Code notification。
 *
 * ★ T2（turnId 贯通，2026-10-11）：**所有 item 类通知都必须带 turnId**。
 *   血案：旧版通知不带 turnId，而 renderer 的 `Nge/qMn/responsePart` 全部要求
 *   `s.activeTurn.id === o.turnId`（不匹配 ⇒ **静默丢弃**）。
 *   ⇒ 桥必须在每条通知上携带当前轮次的 turnId，且该 turnId 必须与
 *     `turn/started` 通知里的 `turn.id` **完全一致**（单一真源）。
 *   调用方通过 `ctx.turnId` 传入当前轮次 id。
 *
 * @param {any} updateParams ACP session/update 参数 {sessionId, update}
 * @param {{turnId?:string, seenAgentItems?:Set<string>, seenReasoningItems?:Set<string>}} [ctx]
 *   当前轮次上下文（由桥的 byThread 提供）。
 *   ★ `seenAgentItems` 是**桥侧跨 update 复用的 Set**，用于判定某 `messageId` 的
 *     `item/started` 是否已发过（见下方 agentMessageChunk 分支的血案与修法）。
 *   ★ `seenReasoningItems`（2026-10-17）同款用途，但管的是 **reasoning（思考）item** ——
 *     thinking 块无 DSH 稳定 id，故以 `think-<turnId>` 为身份。两者必须**分别维护**：
 *     混用一个 Set 会让 agentMessage 与 reasoning 的 id 空间互相污染。
 * @returns {Array<{method:string, params:any}>}
 */
export function translateSessionUpdate(updateParams, ctx = {}) {
  const sessionId = updateParams?.sessionId;
  const u = updateParams?.update ?? {};
  const kind = u.sessionUpdate;
  const out = [];
  const threadId = sessionId;
  // ★ turnId 透传：renderer 强依赖；无则为 undefined（注入层会兜底用当前轮）
  const turnId = ctx?.turnId;

  switch (kind) {
    /**
     * ★★★ 血案修复（2026-10-16，「发送后无任何消息返回」的真正根因）：
     *
     *   【症状】用户发送消息 → 桥 `turn/started`(0.2ms) → `prompt → DSH` → DSH 回
     *     `agent_message_chunk`（实测 21:33:50.020 有 `item/agentMessage/delta`）
     *     → 桥 4.2s 后 `turn/completed`。**链路全通，但界面完全空白。**
     *
     *   【根因·官方源码铁证】`codexMapAppServerEvents.ts` 的 `mapAgentMessageDelta`：
     *     ```js
     *     const partId = state.itemToPartId.get(params.itemId);
     *     if (!partId) {
     *       // Got a delta before we saw the corresponding `item/started`.
     *       // Drop it — ... the lost text is replaced when `item/completed`
     *       // arrives with the full `text` field.
     *       return [];          // ★ 静默丢弃
     *     }
     *     ```
     *     官方明确要求：① delta **必须带 `itemId`**；② 该 item 必须先由
     *     `item/started` 建立 `itemToPartId` 映射；③ 兜底靠 `item/completed` 带全量
     *     `text` 补回。而旧版桥 **三个条件全不满足**：
     *       - delta 没带 `itemId`（params 只有 `{threadId, turnId, delta}`）
     *       - 从未发过 `item/started`（`agentMessage` 类型）
     *       - 从未发过 `item/completed`
     *     ⇒ renderer 逐条丢弃 ⇒ 界面永远空白。
     *
     *   【DSH 侧可用字段】`dsh-acp` 的 `assistantUpdates()` 产出的每条
     *     `agent_message_chunk` 都带 **`messageId = event.data.message.id`**
     *     （见 `temp/dsh-acp-patched/lib/index.js:650`）—— 这是**稳定 ID**，
     *     可直接用作 codex 侧的 `item.id`。
     *     且 `assistantUpdates` 是按「**已提交的完整消息**」产出的（非逐字流），
     *     故一条 chunk 携带的就是整块文本 `block.text`。
     *
     *   【修法】以 `messageId` 为 item 身份，合成一条**完整的 item 生命周期**：
     *     ① 首次见到该 messageId ⇒ 发 `item/started`，`item = { type:"agentMessage",
     *        id:<messageId>, text:<本块全文> }`（官方 `mapItemStartedBody` 用 `item.text`
     *        直接建 part ⇒ 一次性渲染，不依赖后续 delta）；
     *     ② 后续同 id 的块 ⇒ 发 `item/agentMessage/delta`，**必须带 `itemId`**，
     *        renderer 据此 append 到同一 part（`deferResponseWhileToolCallIsOpen` 保序）；
     *     ③ 因 DSH 不给"消息结束"信号，用**下一个 item 或 turn 结束**兜底
     *        （见 bridge.mjs 的 turn 收尾补 `item/completed`）。
     *     `seenAgentItems` 由桥在**每个 turn 开始时清空**（避免跨轮串台）。
     */
    case ACP_UPDATE_KIND.agentMessageChunk: {
      const text = u.content?.type === "text" ? u.content.text : (u.content?.text ?? "");
      // ★ item 身份：优先 DSH 的稳定 messageId；退化用 itemId；再退化用 `msg-<turnId>`
      const itemId = u.messageId ?? u.itemId ?? (turnId ? `msg-${turnId}` : undefined);
      const seen = ctx?.seenAgentItems;
      const firstTime = !seen || !itemId || !seen.has(itemId);
      if (itemId && seen) { seen.add(itemId); }
      /**
       * ★ 契约（官方 proto，commit 6d62b1d5da）：
       *   ThreadItem 的 agentMessage 分支 =
       *     { "type":"agentMessage", id:string, text:string,
       *       phase:MessagePhase|null, memoryCitation:MemoryCitation|null,
       *       delivery:AgentMessageDelivery|null, questions:AsyncUserInputQuestion[]|null }
       *   ItemStartedNotification = { item, threadId, turnId, startedAtMs:number }
       *   ⇒ item 的全部 required 字段都必须给全（可空项显式 null，别省）。
       */
      const agentItem = (id, t) => ({
        id, type: "agentMessage", text: t,
        phase: null, memoryCitation: null, delivery: null, questions: null,
      });
      if (firstTime) {
        out.push({
          method: CODEX_NOTIFICATION.itemStarted,
          params: { threadId, turnId, item: agentItem(itemId, text), startedAtMs: Date.now() },
        });
      } else {
        out.push({
          method: CODEX_NOTIFICATION.agentMessageDelta,
          params: { threadId, turnId, itemId, delta: text },
        });
      }
      break;
    }
    /**
     * ★★★ 2026-10-17 修复（**思考内容永远不显示**）：
     *
     *   【原状】直接发 `item/reasoning/textDelta`，**从不发 `item/started`**。
     *   【根因·与 agentMessage 同族】官方 `mapAgentMessageDelta` 的判据是
     *     `state.itemToPartId.get(itemId)` —— 无映射 ⇒ **静默丢弃**。
     *     reasoning 的唯一区别是 renderer 用 reasoning 专用 part 承载它，
     *     **但"先 started 后 delta"的顺序要求完全一致**。
     *     旧桥只发 delta ⇒ 注入层 `rzDelta` 虽能自建 part（见 inject-snippet:
     *     `if (!c.rz) { create part }`），但那**绕过了 renderer 的 itemToPartId**——
     *     真实 VS Code（非注入层）里这条 delta 会被丢。
     *
     *   【权威契约】`ThreadItem.reasoning` 分支（已落盘 schema，ItemStartedNotification.json）：
     *       required = ["id", "type"]            ← 只有两个！
     *       props    = ["id","type","content","summary"]
     *     即：`{ type:"reasoning", id, content?, summary? }`；
     *     text 走 `content`（不是 `text`！），摘要走 `summary`。
     *
     *   【修法】与 agentMessage 完全同构：
     *     ① 首见该 thinking 块 ⇒ 发 `item/started`，item = `{type:"reasoning", id, content:<首选块全文>}`；
     *     ② 后续 ⇒ 发 `item/reasoning/textDelta`（带 `itemId`）；
     *     ③ turn 收尾由 bridge.mjs 补 `item/completed`（与 agentMessage 同处清理）。
     *   ★ thinking 块没有 DSH 侧的稳定 id ⇒ 以 **turnId 派生**（`think-<turnId>`），
     *     保证同轮内稳定、跨轮不串（跨轮由 turn/start 重置 seenReasoningItems 保证）。
     */
    case ACP_UPDATE_KIND.agentThoughtChunk: {
      const text = u.content?.type === "text" ? u.content.text : (u.content?.text ?? "");
      // ★ item 身份：DSH 的 thinking 块无稳定 id ⇒ 用 turnId 派生（同轮稳定）
      const itemId = u.messageId ?? u.itemId ?? (turnId ? `think-${turnId}` : undefined);
      const seen = ctx?.seenReasoningItems;
      const firstTime = !seen || !itemId || !seen.has(itemId);
      if (itemId && seen) { seen.add(itemId); }
      if (firstTime) {
        out.push({
          method: CODEX_NOTIFICATION.itemStarted,
          params: {
            threadId, turnId,
            // ★ 契约：reasoning 的 required 只有 {id,type}；text 走 content（非 text）
            item: { type: "reasoning", id: itemId, content: text, summary: null },
            startedAtMs: Date.now(),
          },
        });
      } else {
        // ★ T3：reasoning 专用 delta 通道（参照系确有 item/reasoning/textDelta）
        out.push({
          method: CODEX_NOTIFICATION.reasoningTextDelta,
          params: { threadId, turnId, itemId, contentIndex: u.contentIndex ?? 0, delta: text },
        });
      }
      break;
    }
    case ACP_UPDATE_KIND.toolCall: {
      out.push({
        method: CODEX_NOTIFICATION.itemStarted,
        params: {
          threadId, turnId,
          item: { type: "toolCall", toolCallId: u.toolCallId, toolName: u.title ?? u.kind, status: u.status, rawInput: u.rawInput },
        },
      });
      break;
    }
    case ACP_UPDATE_KIND.toolCallUpdate: {
      out.push({
        method: CODEX_NOTIFICATION.itemCompleted,
        params: {
          threadId, turnId,
          item: { type: "toolCall", toolCallId: u.toolCallId, status: u.status, content: u.content, rawOutput: u.rawOutput },
        },
      });
      break;
    }
    case ACP_UPDATE_KIND.plan: {
      out.push({ method: CODEX_NOTIFICATION.itemStarted, params: { threadId, turnId, item: { type: "plan", entries: u.entries } } });
      break;
    }
    case ACP_UPDATE_KIND.configOptionUpdate: {
      out.push({ method: CODEX_NOTIFICATION.threadSettingsUpdated, params: { threadId, configOptions: u.configOptions } });
      break;
    }
    case ACP_UPDATE_KIND.availableCommandsUpdate: {
      out.push({ method: CODEX_NOTIFICATION.skillsChanged, params: { threadId } });
      break;
    }
    /**
     * ★ 2026-10-17 补齐（此前落 default ⇒ 发 type:"unknown" 垃圾 item）：
     *   DSH `usage_update` 表达「上下文占用」（used/size），映射为官方
     *   `thread/tokenUsage/updated`（带 modelContextWindow）。详见 translateUsageUpdate。
     */
    case ACP_UPDATE_KIND.usageUpdate: {
      const n = translateUsageUpdate(threadId, turnId, u);
      if (n) out.push(n);
      break;
    }
    default: {
      /**
       * ★ 2026-10-17 加固：**未知种类不再无声**。
       *   上一个被静默吃掉的种类正是 `usage_update` —— 它落这里后变成
       *   `item/started { item:{ type:"unknown" } }`：既污染 renderer 的 item 列表，
       *   又让「上下文占用」这一真实能力白白丢掉。
       *   现在把 kind 与键名打出来（观测代码，不影响主流程）——
       *   同族铁律：**降级分支必须打日志**，否则永远不知道自己在跑降级路径。
       */
      try {
        if (typeof console !== "undefined" && console.warn) {
          console.warn(`[translate] 未识别的 ACP update kind="${kind}" keys=[${Object.keys(u).join(",")}]`);
        }
      } catch { /* 观测失败绝不影响主流程 */ }
      // 未知种类：透传为通用 item，避免信息丢失
      out.push({ method: CODEX_NOTIFICATION.itemStarted, params: { threadId, turnId, item: { type: "unknown", update: u } } });
    }
  }
  return out;
}

/**
 * ACP `session/prompt` 的完成 → codex `turn/completed`。
 * ★ T2：**必须带 turnId**（renderer 的 PIo 要求 activeTurn.id === turnId 才收尾）。
 */
export function translatePromptDone(sessionId, turnId, durationMs, items = []) {
  // ★★★ 契约修正（2026-10-16，**"卡在正在分析"的根因**）：
  //   权威 `TurnCompletedNotification.required = ["threadId","turn"]`
  //   （openai/codex `app-server-protocol/schema/json/v2/TurnStartedNotification.json`
  //     定义 `Turn.required = ["id","items","status"]`；completed 复用同一 `Turn`）。
  //   此前桥发 `{ threadId, turnId, duration }` —— **完全没有 `turn` 包装**，
  //   `turnId` 也是协议里不存在的扁平字段。
  //   ⇒ VS Code `codexAgent.ts:3121` 执行 `const appTurnId = params.turn.id`
  //   ⇒ `Cannot read properties of undefined (reading 'id')`
  //   ⇒ `[CodexClient error] notification handler turn/completed threw`
  //   ⇒ **turn 永不结束，UI 永远停在"正在分析"**（用户实测症状）。
  //   修：补 `turn: { id, items, status:"completed", completedAt, durationMs }`；
  //   同时保留扁平 `turnId`/`duration`（注入层历史按键读取，零成本向后兼容）。
  //   ★ 时间单位：`Turn.completedAt` 是 **Unix 秒**（schema 明文），`durationMs` 才是毫秒。
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    method: CODEX_NOTIFICATION.turnCompleted,
    params: {
      threadId: sessionId,
      turn: {
        id: turnId,
        items: Array.isArray(items) ? items : [],
        status: "completed",                       // TurnStatus ∈ completed|interrupted|failed|inProgress
        completedAt: nowSec,
        durationMs: Math.max(0, durationMs | 0),   // 毫秒（字段名即单位）
      },
      turnId,
      duration: Math.max(0, durationMs | 0),
    },
  };
}

/**
 * ★ T2：turn 开始 → codex `turn/started`（带 turn.id；renderer 用它建 activeTurn）
 *
 * ★★ 血案修复（2026-10-15）：**必须删 `turn.items`，否则用户消息显示两条**。
 *
 *   双源实测（两处代码都渲染）：
 *     源 A（host，agentHostMain.js `function PY(o,i,e)`）：
 *       `let n=i.turn.items?.[0]; if(n.type==="userMessage") t=Ex(n.content)`
 *       ⇒ 把本函数 `turn.items[0]` 当成 user message 渲染。
 *     源 B（renderer，workbench.desktop.main.js 发送时）：
 *       乐观 dispatch 一条带**本机 `t.message`** 的 `chat/turnStarted`
 *       （`_pendingActions.push` → `_recomputeOptimistic`）。
 *   ⇒ 两条都渲染 ⇒ 用户看到两条相同消息（截图症状）。
 *
 *   ★ 只删 `turn.items`，**保留 `message:{text,origin}`** —— 注入层 reflow 依赖后者。
 *   ★ `turn.id` / `turn.startedAt` 必须留（renderer 的 PIo 要求 activeTurn.id === turnId）。
 */
export function translateTurnStarted(sessionId, turnId, userText, startedAt) {
  // ★★★ 契约修正（2026-10-16）：`Turn.required = ["id","items","status"]`（官方 schema）。
  //   此前只给 `{id, startedAt}` ⇒ 缺 `items`/`status`。
  //   ★ `items` **必须显式为 `[]`**（不能省略）—— 但**不能塞 userMessage**
  //     （见上方血案：塞了会双条）。空数组既满足 required 又不触发源 A 渲染。
  //   ★ 同时保留 `message:{text,origin}` 供注入层 reflow（非协议字段，勿删）。
  return {
    method: CODEX_NOTIFICATION.turnStarted,
    params: {
      threadId: sessionId,
      turn: {
        id: turnId,
        items: [],                                 // ★ required；留空避免双条
        status: "inProgress",
        startedAt: Math.floor(Date.parse(startedAt ?? "") / 1000) || Math.floor(Date.now() / 1000),
      },
      message: { text: userText ?? "", origin: { kind: "user" } },  // 注入层 reflow 兼容字段（勿删）
    },
  };
}

/**
 * ★ T4：token 用量 → codex `thread/tokenUsage/updated`。
 *
 * 【权威契约】`ThreadTokenUsageUpdatedNotification`（openai/codex 0.157.0
 *   `codex-rs/app-server-protocol/schema/json/v2/ThreadTokenUsageUpdatedNotification.json`，
 *   已落盘 `dev/codex-protocol-schema/`）：
 *
 *     required = ["threadId", "tokenUsage", "turnId"]
 *     ThreadTokenUsage  required = ["last", "total"]        ← ★★ 两个都要！
 *       · last  : TokenUsageBreakdown
 *       · total : TokenUsageBreakdown
 *       · modelContextWindow : int64 | null
 *     TokenUsageBreakdown required =
 *       ["cachedInputTokens","inputTokens","outputTokens","reasoningOutputTokens","totalTokens"]
 *
 *   ★★★ 契约违规修复（2026-10-17）：**旧实现只给 `last` 且只有 4 个字段**
 *     （缺 `total`、缺 `totalTokens`、缺 `modelContextWindow`）
 *     ⇒ `tokenUsage.total` 为 `undefined` ⇒ VS Code 消费侧读 `tokenUsage.total.*` 即
 *       `Cannot read properties of undefined`（同一族血案，见 README 契约表）。
 *   ★ 单位：TokenUsageBreakdown 各字段是**计数**（非时间戳），无秒/毫秒陷阱。
 *
 * @param {string} sessionId
 * @param {string} turnId
 * @param {object} usage  形态容忍：{inputTokens|cachedInputTokens|…} 或 snake_case
 * @param {{modelContextWindow?:number|null, total?:object}} [extra]
 *   `modelContextWindow` = 上下文窗口大小（DSH `usage_update.size`）；
 *   `total` = 会话累计（DSH ACP 面不提供 ⇒ 缺省时用 last 兜底，保证 required 满足
 *             且**不伪造数值语义**——注释已声明它是兜底）。
 */
export function translateTokenUsage(sessionId, turnId, usage, extra = {}) {
  if (!usage) return null;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const pick = (o, camel, snake) => num(o?.[camel] ?? o?.[snake]);

  /** TokenUsageBreakdown 的 5 个 required 一次凑齐（缺一即 undefined 崩溃） */
  const breakdown = (o) => {
    if (!o) return null;
    const cachedInputTokens = pick(o, "cachedInputTokens", "cached_input_tokens");
    const inputTokens = pick(o, "inputTokens", "input_tokens");
    const outputTokens = pick(o, "outputTokens", "output_tokens");
    const reasoningOutputTokens = pick(o, "reasoningOutputTokens", "reasoning_output_tokens");
    // totalTokens 优先取上游给的；没给就由四项求和（**确定性推导**，非臆造）
    const totalTokens = o.totalTokens ?? o.total_tokens
      ?? (cachedInputTokens + inputTokens + outputTokens + reasoningOutputTokens);
    return {
      cachedInputTokens,
      inputTokens,
      outputTokens,
      reasoningOutputTokens,
      totalTokens: num(totalTokens),
    };
  };

  const last = breakdown(usage);
  if (!last) return null;
  // ★ total 是 required：上游给了就用，没给则回落到 last（并保留注释说明，不虚构）
  const total = breakdown(extra.total) ?? last;

  const tokenUsage = { last, total };
  // modelContextWindow 是可空 int64 ⇒ 有值才带（null 与缺省在 schema 上等价）
  const mcw = extra.modelContextWindow;
  if (typeof mcw === "number" && Number.isFinite(mcw)) tokenUsage.modelContextWindow = mcw;

  return {
    method: CODEX_NOTIFICATION.tokenUsageUpdated,
    params: { threadId: sessionId, turnId, tokenUsage },
  };
}

/**
 * ★ 2026-10-17 新增：ACP `session/update` kind=`usage_update` → codex `thread/tokenUsage/updated`。
 *
 * DSH 的 `usageUpdate()`（dsh-acp lib/index.js:695）产出：
 *   `{ sessionUpdate:"usage_update", used:<占用 token 总数>, size:<contextWindow> }`
 * —— 它表达的是「**上下文占用**」（used/size 一对），**不是**分项 token 账单
 *   （DSH ACP 面**不**暴露 input/output/cached 拆分）。
 *
 * ⇒ 映射策略（**不虚构**）：
 *   · `modelContextWindow` = `size`（这是 DSH 确实给的语义等价物）
 *   · `last.totalTokens`    = `used`（占用总量）
 *   · 其余分项（input/output/cached/reasoning）= **0**（占位以满足 required；
 *     注释明说"DSH 未提供"，而不是编一个看起来合理的数 —— 遵守「兜底值必须中性」铁律）
 *
 * @param {string} sessionId
 * @param {string} turnId
 * @param {{used?:number, size?:number}} u  usage_update 的 update 体
 */
export function translateUsageUpdate(sessionId, turnId, u) {
  if (!u) return null;
  const used = typeof u.used === "number" && Number.isFinite(u.used) ? u.used : null;
  const size = typeof u.size === "number" && Number.isFinite(u.size) ? u.size : null;
  if (used === null && size === null) return null;
  const occupied = used ?? 0;
  const breakdown = {
    cachedInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: occupied,
  };
  const tokenUsage = { last: { ...breakdown }, total: { ...breakdown } };
  if (size !== null) tokenUsage.modelContextWindow = size;
  return {
    method: CODEX_NOTIFICATION.tokenUsageUpdated,
    params: { threadId: sessionId, turnId, tokenUsage },
  };
}

// ---------------------------------------------------------------- 权限

/**
 * ACP `session/request_permission` 参数 → codex 审批请求参数。
 * codex 侧按工具种类分流到不同 method。
 */
export function translatePermissionRequest(params) {
  const toolCall = params?.toolCall ?? {};
  const kind = toolCall.kind ?? "tool";
  const options = (params?.options ?? []).map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind }));

  // 归类
  let method;
  if (kind === "edit" || kind === "write" || kind === "fileChange") method = CODEX_CLIENT_REQUEST.fileChangeRequestApproval;
  else if (kind === "execute" || kind === "command" || kind === "commandExecution") method = CODEX_CLIENT_REQUEST.commandExecutionRequestApproval;
  else method = CODEX_CLIENT_REQUEST.permissionsRequestApproval;

  // 归一化 options（映射到 codex 的 approve/deny 语义）
  const normalizedOptions = options.map((o) => ({
    optionId: o.optionId,
    name: o.name,
    // ACP kind: allow_once | allow_always | reject_once | reject_always
    decision: typeof o.kind === "string" && o.kind.startsWith("allow") ? "approve"
      : typeof o.kind === "string" && o.kind.startsWith("reject") ? "deny"
        : "unknown",
  }));

  return {
    method,
    params: {
      threadId: params?.sessionId,
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.title ?? kind,
      description: toolCall.title,
      options: normalizedOptions,
      _acpOptions: options, // 保留原始选项，回填时用 optionId
    },
  };
}

/**
 * codex 审批答复 → ACP `session/request_permission` 回执。
 * @param {any} codexReply  codex 侧返回（含 selectedOptionId / decision）
 * @param {any} permReq     translatePermissionRequest 的结果参数
 *
 * ★★★ 血案（2026-10-11）：**VS Code agent host 的真实应答是 `{ result: { decision: "allow" } }`**
 *   （bundle 实证：`_handleCommandApprovalRequestRpc(e){ return { result: { decision: await ... } } }`，
 *    `_handleFileChangeApprovalRequestRpc` 同理）。
 *   而旧实现只读 `codexReply.decision`（顶层）⇒ 拿到 undefined ⇒ wantAllow=false ⇒
 *   挑到 **reject** 选项 ⇒ **用户点「允许」，DSH 收到的却是「拒绝」**（实测复现：
 *   `{result:{decision:"allow"}}` → `{"outcome":"selected","optionId":"reject-once"}`）。
 *   修：先**下钻 `.result`** 再取 decision / selectedOptionId。
 */
export function translateApprovalToAcpOutcome(codexReply, permReq) {
  const acpOptions = permReq?._acpOptions ?? [];
  // ★ 兼容三种形态：顶层、{result:{...}}（VS Code host）、{outcome:{...}}
  const r = codexReply ?? {};
  const body = (r.result && typeof r.result === "object") ? r.result : r;
  const outcomeBody = (r.outcome && typeof r.outcome === "object") ? r.outcome : body;
  let optionId = body.selectedOptionId ?? outcomeBody.selectedOptionId
    ?? body.optionId ?? outcomeBody.optionId;

  if (!optionId) {
    const decision = outcomeBody.decision ?? body.decision
      ?? outcomeBody.outcome ?? body.outcome
      // 兼容 {permissions:{...}} 或 {scope} 类形态：视为已放行
      ?? (body.permissions !== undefined ? "allow" : undefined);
    const wantAllow = decision === "approve" || decision === "allow" || decision === true
      || decision === "accept" || decision === "approved";
    const pick = acpOptions.find((o) => wantAllow ? String(o.kind).startsWith("allow") : String(o.kind).startsWith("reject"));
    optionId = pick?.optionId ?? acpOptions[0]?.optionId;
  }
  if (!optionId) {
    return { outcome: { outcome: "cancelled" } };
  }
  return { outcome: { outcome: "selected", optionId } };
}

export { DSH_AGENT, CODEX_NOTIFICATION, CODEX_CLIENT_REQUEST, ACP_UPDATE_KIND };

// ============================================================================
// ★★★ 历史会话回填：DSH transcript → codex `Turn[]`（2026-10-16）
//
// 【血案】左侧列表有会话、点进去右侧**空白**（无任何消息）。
//   根因：桥 `thread/read` 调 `dsh.listTurns?.()`，而该方法**不存在**（可选链短路）
//   ⇒ `turns` 恒 `[]` ⇒ VS Code 日志 `Restored session ... with 0 turns`。
//
// 【修法】从 DSH 落盘转录（`~/.dsh/sessions/<escaped-cwd>/<id>/session.v4.jsonl.zstd`）
//   读记录 → 翻译成**官方契约**的 `Turn[]`，供 `thread/read`（includeTurns）返回。
//
// 【权威契约】（`codex app-server generate-ts` 产物，逐字）
//   Turn          = { id, items, itemsView, status, error, startedAt, completedAt, durationMs }
//   TurnStatus    = "completed" | "failed" | "inProgress" | "interrupted"
//   TurnItemsView = "full" | "notLoaded" | "summary"
//   ThreadItem.userMessage  = { type:"userMessage",  id, clientId, content: UserInput[] }
//   ThreadItem.agentMessage = { type:"agentMessage", id, text, phase, memoryCitation,
//                                delivery, questions }
//   UserInput.text          = { type:"text", text, text_elements: [] }
//
// ★ 注意：`historyMode` 枚举只有 `legacy|paginated`（旧代码写 `"full"` 属**越界值**，
//   虽被上游宽松处理，但这正是"上游会走 paginated 分支去调 thread/turns/list"的开关。
//   我们**保持非 paginated**（走 includeTurns 全量路径），故仍取 `"legacy"`。
// ============================================================================

/** transcript 事件 → codex `UserInput` 数组 */
function transcriptTextToUserInput(text) {
  // UserInput.text 的 text_elements 是 required（实测产物：Array<TextElement>）
  return [{ type: "text", text: String(text ?? ""), text_elements: [] }];
}

/**
 * transcript 事件 → codex `Turn[]`。
 *
 * 分组策略：按事件的 `turn` 序号分组（DSH 的 `user/message` 通常无 turn 号，
 * 故采用**顺序配对**：一个 user 事件 + 其后的 assistant 事件 = 一个 turn）。
 * 兜底：若事件无 turn 号则按 index 生成稳定 id。
 *
 * ★★ 状态判定（重要）：这些都是**历史**轮次，不应让 UI 显示"进行中"转圈。
 *   若某 turn 有 assistant 文本 ⇒ `completed`；
 *   若**只有 user 无 assistant**（用户问了没答/被中断）⇒ 只要它**不是最后一个**
 *   open turn 就按 `interrupted`（历史已终结）处理；**仅当它是最后一条且无 assistant**
 *   才保持 `inProgress`（可能与正在进行的实时轮次重合）。
 *
 * ★★★ 2026-10-17 升级：**优先用权威边界（turnBoundary）校正**。
 *   上面的"顺序配对 + 有无 assistant"只是**启发式**；`opts.boundaries`（来自
 *   `transcript.mjs::extractTurnBoundaries`，读 `turn/start`/`turn/end` 真值）一旦给出，
 *   则以它为准：
 *     · 有 `turn/end` ⇒ 状态 = 其 `reason.kind` 的映射（completed/failed/interrupted）
 *     · 无 `turn/end` 且是**开放轮** ⇒ `inProgress`（唯一确证的进行中判据）
 *     · 缺 reason（旧格式）⇒ 回落启发式，**不覆盖为 null**
 *   并顺带用真实边界填 `startedAt`/`completedAt`（此前靠消息 time 近似）。
 *
 * @param {Array<{kind:'user'|'assistant',id:string,text:string,turn:number|null,timeMs:number|null}>} events
 * @param {{threadId?:string,
 *          boundaries?:{turns:Array<{turn:number,startedAtMs:number|null,endedAtMs:number|null,
 *                                    reasonKind:string|null,status:string|null}>,
 *                      openTurn:number|null, lastTurn:number}}} [opts]
 * @returns {Array} codex Turn 数组（升序 = 最旧在前，与 includeTurns:true 语义一致）
 */
export function transcriptEventsToTurns(events, opts = {}) {
  const threadId = opts.threadId ?? "thread";
  /** @type {((turnNo:number, status:string, b:object)=>void)|undefined} 状态来源回调（诊断用） */
  const onStatus = typeof opts.onStatus === "function" ? opts.onStatus : undefined;
  if (!Array.isArray(events) || !events.length) return [];

  // ---- ① 分组：优先按**权威轮次号**，无号才回落顺序配对 ----
  /** @type {Array<{turnNo:number|null, users:object[], assistants:object[], t0:number|null, t1:number|null}>} */
  let groups = [];
  const hasTurnInfo = events.some((e) => typeof e.turn === "number");

  if (hasTurnInfo) {
    /**
     * ★★★ 2026-10-17：**按 DSH 轮次号分组**（取代顺序配对）。
     *   实测血案：一轮可含**多条** assistant/message（长 agentic 轮，实测 15 条）
     *   与**多条**真人 user 消息 —— 顺序配对会把 5 轮拆成 17 轮。
     *   `assistant/message.data.turn` 是 DSH 的权威轮次号；user 事件由
     *   `transcript.mjs::tagEventsWithTurn` 按 seq 区间补号。
     */
    const byTurn = new Map();
    for (const e of events) {
      const tn = e.turn;
      if (typeof tn !== "number") continue;       // 无号的（理论上 tagEventsWithTurn 已补齐）
      let g = byTurn.get(tn);
      if (!g) { g = { turnNo: tn, users: [], assistants: [], t0: null, t1: null }; byTurn.set(tn, g); }
      if (e.kind === "user") g.users.push(e);
      else if (e.kind === "assistant") g.assistants.push(e);
      const tm = e.timeMs ?? null;
      if (tm != null) { if (g.t0 == null || tm < g.t0) g.t0 = tm; if (g.t1 == null || tm > g.t1) g.t1 = tm; }
    }
    groups = [...byTurn.values()].sort((a, b) => a.turnNo - b.turnNo);
  } else {
    // 兼容：事件完全没有轮次号 ⇒ 用旧的顺序配对（单 user + 单 assistant = 一轮）
    let cur = null;
    for (const e of events) {
      if (e.kind === "user") {
        if (cur && cur.users.length) groups.push(cur);
        cur = { turnNo: null, users: [e], assistants: [], t0: e.timeMs ?? null, t1: e.timeMs ?? null };
      } else if (e.kind === "assistant") {
        if (!cur) cur = { turnNo: null, users: [], assistants: [], t0: e.timeMs ?? null, t1: null };
        cur.assistants.push(e);
        cur.t1 = e.timeMs ?? null;
        groups.push(cur);
        cur = null;
      }
    }
    if (cur && (cur.users.length || cur.assistants.length)) groups.push(cur);
  }

  // —— ② 组装 Turn ——
  const toSec = (ms) => (typeof ms === "number" && Number.isFinite(ms))
    ? (ms > 1e12 ? Math.floor(ms / 1000) : Math.floor(ms)) : null;

  // ★ 权威边界索引（可选）：turn 号 → {status, startedAtMs, endedAtMs}
  const bnd = opts.boundaries ?? null;
  const bndByTurn = new Map();
  if (bnd && Array.isArray(bnd.turns)) for (const t of bnd.turns) bndByTurn.set(t.turn, t);

  return groups.map((g, i) => {
    const isLast = i === groups.length - 1;
    const items = [];
    // ★ 一轮内的**全部**用户消息（顺序保留）
    for (const u of g.users) {
      items.push({
        type: "userMessage",
        id: String(u.id ?? `user-${i}`),
        clientId: null,
        content: transcriptTextToUserInput(u.text),
      });
    }
    /**
     * ★ 一轮内的**全部** assistant 消息。取「最后一条非空」为最终答复：
     *   长 agentic 轮里前面的 assistant 往往是中间说明/工具前后语，最后一条才是结论。
     *   ★ 只输出**一条** agentMessage（官方 codex 一轮通常一条 agentMessage item；
     *     多条会让 renderer 生成多个并列气泡，与真实 codex 观感不符）。
     *   ★ 这是**有意的信息取舍**：中间过程（工具调用/思考）由 reasoning 与
     *     toolCall 通道承载，此处只保留最终文本。注释明示，避免被当 bug。
     */
    const lastAssistant = g.assistants.length ? g.assistants[g.assistants.length - 1] : null;
    if (lastAssistant) {
      items.push({
        type: "agentMessage",
        id: String(lastAssistant.id ?? `agent-${i}`),
        text: String(lastAssistant.text ?? ""),
        phase: null,
        memoryCitation: null,
        delivery: null,
        questions: null,
      });
    }
    // ★ 历史轮次状态：有答 ⇒ completed；无答 ⇒ 只有最后一条才可能 inProgress，
    //   其余按 interrupted（历史已终结，避免 UI 误显示"进行中"）。
    let status;
    if (lastAssistant) status = "completed";
    else status = isLast ? "inProgress" : "interrupted";

    const startedAt = toSec(g.t0);
    const completedAt = toSec(g.t1 ?? g.t0);
    let durationMs = (startedAt != null && completedAt != null)
      ? Math.max(0, (completedAt - startedAt) * 1000) : null;

    /**
     * ★★★ 2026-10-17：**权威边界校正**（若调用方提供 boundaries）。
     *   ★ 关键修正 ①：分组按 DSH 轮次号 ⇒ 直接用 **该组自己的 `turnNo`** 查边界。
     *     因为分组后"第 i 组"未必对应"第 i 号轮次"（某轮只有 system 消息而被跳过 ⇒ 号码有洞）。
     *   ★ 关键修正 ②（同日二次加固，血案驱动）：
     *     **无 `turnNo` 时禁用边界校正，一律走启发式**。
     *     此前为兼容旧行为保留了"位置 `i+1` 查边界"的回落，实测暴露出**语义错误**：
     *       会话 `...3b9a96cffd` 只有 1 个 `turn/start`+`turn/end(reason:error)` 而**无任何
     *       assistant 文本**（纯 API-key 报错轮）；另有会话边界有 4 个 turn 而事件 4 条
     *       user 全无号。位置 `i+1` 恰好命中 ⇒ 把"有内容轮"的终态**错标**成隔壁轮的
     *       `failed`/`interrupted`（实测虚构出 32 个 failed，占全量 failed 的 97%）。
     *     位置 ≠ 轮次号，**这是不可靠的猜测**，必须废除。
     *     （生产路径 bridge.mjs 会先调 `tagEventsWithTurn` 补号，因此正常都不会走到这里；
     *      走到这里说明"事件完全无号 + 有边界"，此时任何位置猜测都不如启发式诚实。）
     */
    let statusSource = "heuristic";
    const hasTurnNo = (typeof g.turnNo === "number");
    const lookupTurn = hasTurnNo ? g.turnNo : null;
    const b = (bndByTurn.size > 0 && lookupTurn !== null) ? bndByTurn.get(lookupTurn) : null;
    if (b && b.status) {
      status = b.status;                       // completed | failed | interrupted
      statusSource = `boundary:${b.reasonKind ?? "?"}`;
      if (onStatus) { try { onStatus(lookupTurn, status, b); } catch { /* 观测不影响主流程 */ } }
    } else if (b && b.endedAtMs === null && b.startedAtMs !== null) {
      // 无 turn/end ⇒ 开放轮 ⇒ 确证的 inProgress（比启发式可靠）
      status = "inProgress";
      statusSource = "boundary:open";
    } else if (hasTurnNo) {
      // 有轮次号但边界表里查不到（边界缺失/半截写入）⇒ 保留启发式，标注来源
      statusSource = "heuristic:no-boundary";
    } else if (bndByTurn.size > 0) {
      // ★ 有边界表但本组无轮次号 ⇒ 明示"放弃校正"（防静默失真；铁律：降级必须打日志）
      statusSource = "heuristic:no-turnno-with-boundaries";
      try {
        console.warn(`[translate] 轮次分组无 turnNo 但有边界表（${bndByTurn.size} 轮）⇒ 放弃边界校正，走启发式 status=${status}`);
      } catch { /* 日志失败不影响主流程 */ }
    }

    // ★ 真实边界时间优先（比消息 time 更权威）
    const bStart = toSec(b?.startedAtMs ?? null);
    const bEnd = toSec(b?.endedAtMs ?? null);
    const effStart = bStart ?? startedAt;
    const effEnd = bEnd ?? completedAt;
    durationMs = (effStart != null && effEnd != null)
      ? Math.max(0, (effEnd - effStart) * 1000) : durationMs;

    return {
      // id 用**轮次号**派生（有号时更稳定：与 DSH turn 号一一对应，便于对账）
      id: (typeof g.turnNo === "number")
        ? `${String(threadId).slice(-8)}-turn-${g.turnNo}`
        : `${String(threadId).slice(-8)}-turn-${i + 1}`,
      items,
      itemsView: "full",
      status,
      statusSource,                          // ★ 非协议字段：标注状态来源，便于诊断（不破上游宽松解析）
      turnNo: g.turnNo ?? null,              // ★ 非协议字段：DSH 轮次号，便于与转录对账
      error: null,
      startedAt: effStart,
      completedAt: status === "inProgress" ? null : effEnd,
      durationMs: status === "inProgress" ? null : durationMs,
    };
  });
}

/**
 * 便捷入口：transcript 记录 → codex `Turn[]`（内部完成事件提取 + 轮次打标 + 边界校正）。
 *
 * ★ 2026-10-17：推荐使用本入口而非手动 `extractConversationEvents` + `transcriptEventsToTurns`
 *   —— 它会把「**轮次打标**」（`tagEventsWithTurn`，用 turn/start/turn/end 的 seq 区间
 *   给 user 事件补 turn 号）与「**边界提取**」（`extractTurnBoundaries`）一并做掉，
 *   从而启用按轮次号分组（而非顺序配对）。
 *
 * @param {Array} records  transcript 记录（readTranscript 的 records）
 * @param {{threadId?:string, extract?:Function, tag?:Function, boundaries?:Function}} [opts]
 *   `extract` / `tag` / `boundaries` 允许注入（便于单测）；缺省时从 transcript.mjs 动态取。
 */
export async function transcriptRecordsToTurnsAsync(records, opts = {}) {
  const mod = await import("./transcript.mjs");
  const extract = opts.extract ?? mod.extractConversationEvents;
  const tag = opts.tag ?? mod.tagEventsWithTurn;
  const bndFn = opts.boundaries ?? mod.extractTurnBoundaries;
  const { events } = extract(records);
  const tagged = tag ? tag(events, records) : events;
  const boundaries = bndFn ? bndFn(records) : null;
  return transcriptEventsToTurns(tagged, { threadId: opts.threadId, boundaries });
}

/**
 * 便捷入口（同步版）：transcript 记录 → codex `Turn[]`。
 * @deprecated 2026-10-17：**不做轮次打标**，在"一轮含多条 assistant/user"的会话上
 *   会过分裂。新代码请用 `transcriptRecordsToTurnsAsync`。
 * @param {Array} records  transcript 记录（readTranscript 的 records）
 * @param {{threadId?:string, extract:(records:Array)=>{events:Array}}} [opts]
 */
export function transcriptRecordsToTurns(records, opts = {}) {
  const extract = opts.extract;
  const events = extract ? extract(records).events : [];
  return transcriptEventsToTurns(events, opts);
}
