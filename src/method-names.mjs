/**
 * 两侧协议方法名常量 —— 桥的翻译契约。
 *
 * A 侧 = DSH ACP（来自 @agentclientprotocol/sdk@1.4.0 AGENT_METHODS / CLIENT_METHODS，实测字面量）
 * C 侧 = VS Code codex app-server（来自 agentHostMain.js 里所有 .request("<m>") / .onRequest("<m>")）
 */

/** DSH ACP：桥 → DSH 的请求（agent 侧） */
export const DSH_AGENT = {
  initialize: "initialize",
  authenticate: "authenticate",
  providersList: "providers/list",
  providersSet: "providers/set",
  providersDisable: "providers/disable",
  sessionNew: "session/new",
  sessionLoad: "session/load",
  sessionSetMode: "session/set_mode",
  sessionSetConfigOption: "session/set_config_option",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionList: "session/list",
  sessionDelete: "session/delete",
  sessionFork: "session/fork",
  sessionResume: "session/resume",
  sessionClose: "session/close",
  mcpMessage: "mcp/message",
  logout: "logout",
  /** ★ 2026-10-15 扩展（非 ACP 标准）：per-model 能力元数据（contextWindow/vision/reasoning）。
   *  DSH 侧由 `packages/acp/acp/src/model-info.ts` 实现，`_` 前缀 = ACP 扩展命名空间。
   *  旧版 DSH 无此方法 ⇒ 返回 -32601 ⇒ 桥侧降级（见 dsh-acp-client.mjs::modelsInfo）。 */
  modelsInfo: "_deepseek/models",
  /** ★ 2026-10-15 扩展（bowei 私有，非 ACP 标准）：per-session 直改沙箱三档。
   *  DSH 侧由我们注入的 `_bowei/sandbox-setMode` 实现（内部 `session.append('sandbox/mode',{mode})`），
   *  是**唯一能绕开 session pin 的当场生效写路径**。旧版/未装补丁的 DSH 无此方法 ⇒ -32601
   *  ⇒ 桥侧降级回 profile patch 路线（见 bridge.mjs::applyDshPermissionMode）。 */
  boweiSandboxSetMode: "_bowei/sandbox-setMode",

  // ---- DSH → 桥（client 侧）----
  sessionUpdate: "session/update",
  sessionRequestPermission: "session/request_permission",
  fsReadTextFile: "fs/read_text_file",
  fsWriteTextFile: "fs/write_text_file",
  terminalCreate: "terminal/create",
  terminalOutput: "terminal/output",
  terminalRelease: "terminal/release",
  terminalWaitForExit: "terminal/wait_for_exit",
  terminalKill: "terminal/kill",
  mcpConnect: "mcp/connect",
  mcpDisconnect: "mcp/disconnect",
  elicitationCreate: "elicitation/create",
  elicitationComplete: "elicitation/complete",
};

/** VS Code codex app-server：VS Code → 桥 的请求（桥必须实现） */
export const CODEX_HOST_REQUEST = {
  initialize: "initialize",
  // 数据类
  modelList: "model/list",
  skillsList: "skills/list",
  /** ★ 路线 B 扩展（非 codex 原生）：桥自行发现的 DSH agent preset 清单 */
  agentList: "agent/list",
  hooksList: "hooks/list",
  mcpServerStatusList: "mcpServerStatus/list",
  mcpServerResourceRead: "mcpServer/resource/read",
  mcpServerToolCall: "mcpServer/tool/call",
  configMcpServerReload: "config/mcpServer/reload",
  configRead: "config/read",
  configBatchWrite: "config/batchWrite",
  // 会话
  threadStart: "thread/start",
  threadResume: "thread/resume",
  threadList: "thread/list",
  threadRead: "thread/read",
  threadFork: "thread/fork",
  threadArchive: "thread/archive",
  threadUnarchive: "thread/unarchive",
  threadRevert: "thread/revert",
  threadUnsubscribe: "thread/unsubscribe",
  threadCompactStart: "thread/compact/start",
  threadSettingsUpdate: "thread/settings/update",
  threadTurnsList: "thread/turns/list",
  threadApproveGuardianDeniedAction: "thread/approveGuardianDeniedAction",
  // 轮次
  turnStart: "turn/start",
  turnSteer: "turn/steer",
  turnInterrupt: "turn/interrupt",
  // 账号
  accountRead: "account/read",
  accountLoginStart: "account/login/start",
  accountLogout: "account/logout",
  accountRateLimitsRead: "account/rateLimits/read",
  getAuthStatus: "getAuthStatus",
};

/** VS Code codex app-server：桥 → VS Code 的请求（审批类） */
export const CODEX_CLIENT_REQUEST = {
  commandExecutionRequestApproval: "item/commandExecution/requestApproval",
  fileChangeRequestApproval: "item/fileChange/requestApproval",
  permissionsRequestApproval: "item/permissions/requestApproval",
  toolCall: "item/tool/call",
  toolRequestUserInput: "item/tool/requestUserInput",
  mcpServerElicitationRequest: "mcpServer/elicitation/request",
};

/**
 * VS Code codex app-server：桥 → VS Code 的通知（事件流）。
 *
 * ★ 契约真源（2026-10-11 三态审计 + renderer reducer 取证）：
 *   - 参照系 = agentHostMain.js 的 `onNotification("<m>")` 全集（共 21 条）。
 *   - 本次修正（T3/T4）：
 *       ① 新增 reasoning 专用通道三条（原用 item/started type:reasoning 兜底，非最优）；
 *       ② 新增 thread/tokenUsage/updated、mcpServer/startupStatus/updated；
 *       ③ **删除** item/autoApprovalReview/started —— 参照系只有 .../completed，
 *          host 发 started 而从不发 completed 属**不对称的多余项**（三态审计标 ⚠️ 多余）。
 */
export const CODEX_NOTIFICATION = {
  turnStarted: "turn/started",
  itemStarted: "item/started",
  itemCompleted: "item/completed",
  agentMessageDelta: "item/agentMessage/delta",
  // ★ T3：reasoning 专用通道（与参照系一致；注入层 reflow 有对应 case）
  reasoningTextDelta: "item/reasoning/textDelta",
  reasoningSummaryTextDelta: "item/reasoning/summaryTextDelta",
  reasoningSummaryPartAdded: "item/reasoning/summaryPartAdded",
  commandExecutionOutputDelta: "item/commandExecution/outputDelta",
  fileChangePatchUpdated: "item/fileChange/patchUpdated",
  fileChangeOutputDelta: "item/fileChange/outputDelta",
  mcpToolCallProgress: "item/mcpToolCall/progress",
  // ★ T4：补齐缺失通知
  tokenUsageUpdated: "thread/tokenUsage/updated",
  mcpServerStartupStatusUpdated: "mcpServer/startupStatus/updated",
  accountUpdated: "account/updated",
  accountRateLimitsUpdated: "account/rateLimits/updated",
  skillsChanged: "skills/changed",
  threadSettingsUpdated: "thread/settings/updated",
  turnCompleted: "turn/completed",
};

/** ACP session/update 的子类型（DSH 会推的种类） */
export const ACP_UPDATE_KIND = {
  agentMessageChunk: "agent_message_chunk",
  agentThoughtChunk: "agent_thought_chunk",
  toolCall: "tool_call",
  toolCallUpdate: "tool_call_update",
  plan: "plan",
  availableCommandsUpdate: "available_commands_update",
  currentModeUpdate: "current_mode_update",
  configOptionUpdate: "config_option_update",
  /**
   * ★ 2026-10-17 补齐（**此前是缺口**）：DSH `dsh-acp` 的 `assistantUpdates()`
   *   在每条 assistant/message 之后会追加一条 `usage_update`：
   *     `{ sessionUpdate:"usage_update", used:<tokenMeter.measure(session).totalTokens>, size:<contextWindow> }`
   *   （源码铁证：`@deepseek-ai/dsh-acp` lib/index.js:695-705 `usageUpdate()`）
   *   ★ 桥此前**没有这个 kind** ⇒ 落 `default` 分支 ⇒ 发
   *     `item/started { item:{ type:"unknown", update:{...} } }` 垃圾 item。
   *   它既污染 renderer 的 item 列表，又让「上下文占用量」这个真实 UI 能力白白丢掉。
   *   修：识别它 → 翻译成官方 `thread/tokenUsage/updated`（带 `modelContextWindow`）。
   *   ★ 这是「ACP update 种类全集」的第 7 种 —— 与 dsh-acp 产出的 6 种并列。
   *   核对方法：`grep -o 'sessionUpdate: *"[a-z_]*"' dsh-acp/lib/index.js | sort -u`
   */
  usageUpdate: "usage_update",
};
