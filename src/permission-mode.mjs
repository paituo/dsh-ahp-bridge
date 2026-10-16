/**
 * 三档权限映射 —— VS Code（copilot-sdk codex 契约） ⇄ DSH SandboxMode
 *
 * ============================ 为什么需要这个模块 ============================
 *
 * 两侧各有一套「三档权限」，**名字完全不同**，桥必须做双向映射：
 *
 * ── A 侧：VS Code / copilot-sdk 的 `permissions.setMode`
 *     载荷 `{ mode }`，`PermissionMode` 取自 SDK 的 generated/session-events.d.ts：
 *       type PermissionMode = "manual" | "assisted" | "allow-all";
 *     · manual      —— 权限请求走正常审批流
 *     · assisted    —— 请求附带 LLM 安全建议，客户端可自动批准"可接受"的
 *     · allow-all   —— 工具/路径/URL 权限请求一律自动批准
 *     派生自 VS Code 的 `autoApprove` 配置（default / assisted / autoApprove）：
 *       `_getSdkPermissionMode(){ return _isBypassApprovals() ? "allow-all"
 *          : _getConfiguredApprovalLevel()==="assisted" ? "assisted" : "manual" }`
 *
 * ── B 侧：DSH 的 `SandboxMode`（dsh-sandbox / dsh-sandbox-policy 权威定义）
 *       type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
 *       type ApprovalPolicy = "ask" | "never";
 *     三档 preset（dsh-base/cordis.patch.yml，逐字）：
 *       read-only:         { sandbox: read-only,         approval: ask   }
 *       workspace-write:   { sandbox: workspace-write,   approval: ask   }
 *       danger-full-access:{ sandbox: danger-full-access, approval: never }
 *     ★ 写路径是**会话日志事件**（dsh-sandbox-policy 里注释明写 "THE write path"）：
 *       `function setSandboxMode(session, mode){ session.append("sandbox/mode", { mode }) }`
 *     ★ 但该写路径**未经 ACP 暴露**（DSH acp 只注册 9 个 onRequest，穷举无沙箱入口）；
 *       且 `session/set_config_option` 对 preset 会抛 `AcpPresetLockedError`
 *       （"the agent preset is fixed for a session"）。
 *     ⇒ **唯一可行的落点 = 部署层 profile patch**（`~/.dsh/profiles/<profile>/cordis.patch.yml`），
 *       它用 `!!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'` 决定档位，
 *       且 acp profile **已启用 HMR**（`- id: hmr / disabled: false`）⇒ 改文件即热加载。
 *
 * ── 第三套（VS Code UI 显示用）：`codex.sandboxMode`
 *       enum: ["read-only","workspace-write","danger-full-access"]   ← 与 DSH **同名同值**
 *     由 `Wx(o)` 从权限预设派生：
 *       "default"     → {approvalPolicy:"on-request", sandboxMode:"workspace-write"}
 *       "auto-review" → {approvalPolicy:"on-request", sandboxMode:"workspace-write", auto_review}
 *       "full-access" → {approvalPolicy:"never",      sandboxMode:"danger-full-access"}
 *     ⇒ **这一套是"能直接对上 DSH 的"**，所以桥以它为权威档位来源。
 *
 * ============================ 映射表（本模块的契约） ============================
 *
 *   DSH SandboxMode        | VS Code codex.sandboxMode | PermissionMode（setMode 载荷）
 *   -----------------------|---------------------------|------------------------------
 *   read-only              | read-only                 | (无直接对应，按 manual 处理)
 *   workspace-write        | workspace-write           | manual / assisted
 *   danger-full-access     | danger-full-access        | allow-all
 *
 *   反查（PermissionMode → DSH）：
 *     allow-all  → danger-full-access
 *     assisted   → workspace-write
 *     manual     → workspace-write
 */

/** DSH 三档（权威顺序，来自 dsh-sandbox-policy 的 SANDBOX_MODES） */
export const DSH_SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];

/**
 * ★ DSH 的**部署默认档**（未显式指定任何档位时 DSH 自己会用的值）。
 *
 * 依据：本机 acp profile 的 `cordis.patch.yml` 托管块把 sandbox-policy.mode 定为
 * `workspace-write`（中性安全态），且 dsh-base bundle 的 permission presets 里
 * `workspace-write` 是「默认工作档」。桥用它判断"用户是否显式偏离过默认"，
 * 从而决定新建会话时是否需要主动接管档位（避免无谓调用）。
 */
export const DSH_DEFAULT_MODE = "workspace-write";

/** DSH 审批策略两档（dsh-user-approval 的 ApprovalPolicy） */
export const DSH_APPROVAL_POLICIES = ["ask", "never"];

/** VS Code copilot-sdk 的 PermissionMode 三档（permissions.setMode 载荷） */
export const SDK_PERMISSION_MODES = ["manual", "assisted", "allow-all"];

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 三轴权限（2026-10-16 血案修复：「审核方式 / 交互方式 / 权限」没接到 DSH）
//
// 【血案】用户报「审核方式、交互方式、权限都没有接到 DSH」。
//
// 【根因（官方源码逐行实证，commit 6d62b1d5da）】
//   VS Code 的 Codex provider **不是**通过独立的 `permissions/setMode` 下发权限，
//   而是把三条轴塞进 **`turn/start` 的参数**里（`codexAgent.ts::_turnStartOptions()`
//   明确 `Pick<TurnStartParams, 'approvalPolicy' | 'permissions' | 'approvalsReviewer'
//   | 'effort' | 'runtimeWorkspaceRoots' | 'personality' | 'summary' | 'collaborationMode'>`）。
//   —— 而桥的 `turnStartToPrompt()` **只取了 sessionId/prompt/vscodeTurnId**，
//      这四个字段**全部被丢弃** ⇒ 三轴永远停留在 DSH 的 pinned 默认档。
//   （实测佐证：整个会话 agenthost.log 里 `permissions/setMode` 调用数 = **0**。）
//
// 【权威映射（`codexSessionConfigKeys.ts` 逐字）】
//   CodexPermissionsPreset | approvalPolicy | sandboxMode        | approvalsReviewer
//   -----------------------|----------------|--------------------|------------------
//   default                | on-request     | workspace-write    | user
//   auto-review            | on-request     | workspace-write    | auto_review
//   full-access            | never          | danger-full-access | user
//
//   交互方式（`codexSessionConfigKeys(node).ts::collaborationModeKind` 逐字）：
//     VS Code "Plan" → codex `plan`；"Interactive" → codex `default`
// ══════════════════════════════════════════════════════════════════════════

/** Codex 权限预设三档（顺序取自官方 CODEX_PERMISSIONS_PRESETS） */
export const CODEX_PERMISSIONS_PRESETS = ["default", "auto-review", "full-access"];

/** ★ 权威：Codex 权限预设 → 三轴。逐字取自官方 `resolveCodexPermissionsPreset()`。 */
export const CODEX_PRESET_TO_AXES = {
  "default":     { approvalPolicy: "on-request", sandboxMode: "workspace-write",    approvalsReviewer: "user" },
  "auto-review": { approvalPolicy: "on-request", sandboxMode: "workspace-write",    approvalsReviewer: "auto_review" },
  "full-access": { approvalPolicy: "never",      sandboxMode: "danger-full-access", approvalsReviewer: "user" },
};

/** Codex approvalsReviewer 闭集（官方 union） */
export const CODEX_APPROVALS_REVIEWERS = ["user", "auto_review", "guardian_subagent"];

/** Codex approvalPolicy 闭集（官方 union） */
export const CODEX_APPROVAL_POLICIES = ["never", "on-request", "untrusted"];

/**
 * 把 `turn/start` 里可能出现的**权限三轴**归一到 DSH 档位 + 审批策略。
 *
 * 输入来源（按优先级，任一存在即可）：
 *   ① `params.permissions`            —— 预设名（`default|auto-review|full-access`）
 *   ② `params.sandboxMode`/`sandbox`  —— 直接沙箱档（最直接，可覆盖预设）
 *   ③ `params.approvalPolicy`         —— `never|on-request|untrusted`（legacy 单轴）
 *   ④ `params.approvalsReviewer`      —— `user|auto_review|guardian_subagent`（legacy 单轴）
 *   ⑤ `params.collaborationMode.mode` —— `plan|default`（交互方式，不映射沙箱，桥自用记录）
 *
 * ★ 设计原则：**宁可 null（保持现档）也不猜** —— 猜错会把用户的"只读"静默升成"可写"。
 *
 * @param {any} params turn/start 原始参数
 * @returns {{sandboxMode:string|null, approval:string|null, reviewer:string|null, interactionMode:string|null, source:string}}
 */
export function resolveTurnPermissionAxes(params = {}) {
  const out = { sandboxMode: null, approval: null, reviewer: null, interactionMode: null, source: "none" };

  // —— ① 预设名（最权威：一次给出三轴）——
  const presetRaw = typeof params.permissions === "string" ? params.permissions.trim() : null;
  const preset = presetRaw ? presetRaw.replace(/^profile:/, "").toLowerCase() : null;
  if (preset && CODEX_PRESET_TO_AXES[preset]) {
    const ax = CODEX_PRESET_TO_AXES[preset];
    out.sandboxMode = ax.sandboxMode;
    out.approval = ax.approvalPolicy === "never" ? "never" : "ask";
    out.reviewer = ax.approvalsReviewer;
    out.source = `preset:${preset}`;
  }

  // —— ② 直接沙箱档（可覆盖预设）——
  const sandboxDirect = codexModeToDshMode(params.sandboxMode ?? params.sandbox?.type ?? params.sandbox);
  if (sandboxDirect) {
    out.sandboxMode = sandboxDirect;
    out.source = out.source === "none" ? "sandbox" : out.source + "+sandbox";
  }

  // —— ③ approvalPolicy（legacy 单轴）——
  const ap = typeof params.approvalPolicy === "string" ? params.approvalPolicy : null;
  if (ap && CODEX_APPROVAL_POLICIES.includes(ap)) {
    out.approval = ap === "never" ? "never" : "ask";
    if (out.source === "none") out.source = "approvalPolicy";
  }

  // —— ④ approvalsReviewer（legacy 单轴）——
  const ar = typeof params.approvalsReviewer === "string" ? params.approvalsReviewer : null;
  if (ar && CODEX_APPROVALS_REVIEWERS.includes(ar)) {
    out.reviewer = ar;
    if (out.source === "none") out.source = "approvalsReviewer";
  }

  // —— ⑤ 交互方式（plan | default）——
  const cm = params.collaborationMode;
  const modeRaw = typeof cm === "object" && cm ? cm.mode : (typeof cm === "string" ? cm : null);
  if (modeRaw === "plan" || modeRaw === "default") {
    out.interactionMode = modeRaw;
    if (out.source === "none") out.source = "collaborationMode";
  }

  return out;
}

/** reviewer → DSH 侧可比拟信息（DSH 无 reviewer 概念；auto_review ≈ 自动审阅）。 */
export function reviewerToDshHint(reviewer) {
  if (reviewer === "auto_review" || reviewer === "guardian_subagent") return { autoReview: true };
  if (reviewer === "user") return { autoReview: false };
  return null;
}

/** DSH 三档 → { sandbox, approval }（与 dsh-base bundle 里 permission presets 逐字一致） */
export const DSH_MODE_TO_KNOBS = {
  "read-only":           { sandbox: "read-only",           approval: "ask"   },
  "workspace-write":     { sandbox: "workspace-write",     approval: "ask"   },
  "danger-full-access":  { sandbox: "danger-full-access",  approval: "never" },
};

/** ★ 权威：DSH SandboxMode → VS Code codex.sandboxMode（同名同值，直通） */
export function dshModeToCodexMode(dshMode) {
  return DSH_SANDBOX_MODES.includes(dshMode) ? dshMode : null;
}

/** ★ 权威：VS Code codex.sandboxMode → DSH SandboxMode（同名同值，直通） */
export function codexModeToDshMode(codexMode) {
  return DSH_SANDBOX_MODES.includes(codexMode) ? codexMode : null;
}

/**
 * 反查：copilot-sdk 的 PermissionMode（permissions.setMode 载荷）→ DSH SandboxMode。
 *
 * ★ 这一个映射是**单向且有损的** —— SDK 那套（manual/assisted/allow-all）只有
 *   3 个语义档，且**没有 read-only**：manual 与 assisted 都落到 workspace-write。
 *   所以「只读」档在 SDK 通道上表达不出来，必须靠 codex.sandboxMode 那条路补齐
 *   （见 `resolveDshModeFromSignals`）。
 */
export function permissionModeToDshMode(permissionMode) {
  switch (permissionMode) {
    case "allow-all": return "danger-full-access";
    case "assisted":  return "workspace-write";
    case "manual":    return "workspace-write";
    default:          return null;
  }
}

/** 反查：DSH SandboxMode → 最接近的 PermissionMode（供 UI 状态回读） */
export function dshModeToPermissionMode(dshMode) {
  switch (dshMode) {
    case "danger-full-access": return "allow-all";
    case "workspace-write":    return "manual";
    case "read-only":          return "manual";
    default:                   return null;
  }
}

/**
 * ★★ 组合解析：把桥同时可能收到的两路信号，收敛成唯一的 DSH 档位。
 *
 * 两路信号（VS Code 可能任一 / 两者都发，取决于 UI 走哪条交互）：
 *   ① `permissions.setMode({mode})`      —— SDK 三档（manual/assisted/allow-all）
 *   ② `options.update({sandboxConfig})`  —— 沙箱路径/网络规则（**不含档位**，只有 enabled）
 *   ③ 会话配置里的 `codex.sandboxMode`   —— 与 DSH 同名同值（**最权威**）
 *
 * 优先级：**③ > ① > 现有档位**（③ 是最直接的表达，① 是有损的近似）。
 *
 * @param {{ codexSandboxMode?: string, permissionMode?: string, current?: string }} sig
 * @returns {string|null} DSH SandboxMode，无法判定时返回 null（调用方应保持现档）
 */
export function resolveDshModeFromSignals(sig = {}) {
  // ③ codex.sandboxMode 直通（权威）
  const direct = codexModeToDshMode(sig.codexSandboxMode);
  if (direct) return direct;

  // ① SDK PermissionMode 反查（有损，但仍比不动强）
  const viaSdk = permissionModeToDshMode(sig.permissionMode);
  if (viaSdk) return viaSdk;

  // ② can't infer
  const cur = codexModeToDshMode(sig.current);
  return cur ?? null;
}

/**
 * 生成写进 profile patch 的**权限三行块**（覆盖 base bundle 的同名 id）。
 * ★ 为什么必须覆盖三行而不是一行：
 *   base bundle 里三行是**联动**的 —— `sandbox-policy.mode` 定档、
 *   `approval.policy` 由它派生、`permission.presets` 提供 UI 可见的档位表。
 *   只改 `sandbox-policy` 会导致「执行放开但审批仍 ask」的不一致（或反之）。
 *
 * ★ 用 `!!js` 表达式读 `DSH_PERMISSION_MODE`（与 base bundle 同风格），
 *   并**显式 pin 默认档**，使桥不改文件时行为不变（幂等、可回退）。
 *
 * @param {string} dshMode 三档之一
 * @returns {string[]} YAML 行数组（顶层 `- id:` 条目，可直接拼进 patch 数组）
 */
export function renderPermissionOverrideBlock(dshMode) {
  const knobs = DSH_MODE_TO_KNOBS[dshMode] ?? DSH_MODE_TO_KNOBS["workspace-write"];
  return [
    `# ==== BOWEI-AHP-PERMISSION-BEGIN (auto-managed; do not edit by hand) ====`,
    `# 桥按 VS Code 权限档写入 DSH 三档（${dshMode}）。`,
    `# 三行联动覆盖 base bundle：sandbox-policy 定档 / approval 派生 / permission 表。`,
    `- id: sandbox-policy`,
    `  name: "@deepseek-ai/dsh-sandbox-policy"`,
    `  config:`,
    `    mode: !!js process.env.DSH_PERMISSION_MODE ?? '${knobs.sandbox}'`,
    `    workspaceRoot: !!js process.cwd()`,
    `- id: approval`,
    `  name: "@deepseek-ai/dsh-user-approval"`,
    `  config:`,
    `    policy: !!js "(process.env.DSH_PERMISSION_MODE ?? '${knobs.sandbox}') === 'danger-full-access' ? 'never' : '${knobs.approval}'"`,
    `- id: permission`,
    `  name: "@deepseek-ai/dsh-permission-presets"`,
    `  config:`,
    `    presets:`,
    `      read-only:`,
    `        sandbox: read-only`,
    `        approval: ask`,
    `      workspace-write:`,
    `        sandbox: workspace-write`,
    `        approval: ask`,
    `      danger-full-access:`,
    `        sandbox: danger-full-access`,
    `        approval: never`,
    `# ==== BOWEI-AHP-PERMISSION-END ====`,
  ];
}
