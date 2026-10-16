# 路线 B 突破：DSH preset 进入 VS Code agent picker（5/5 命中）

**日期**：2026-10-11 23:20
**指令**：删除环境变量中的 `ELECTRON_RUN_AS_NODE`；选成 DSH 会话，也还是没有 DSH 的 AGENT

---

## 一、环境变量清理 ✅

`ELECTRON_RUN_AS_NODE` **只存在于进程级**（User / Machine 级均为空）——是 Agent 沙箱给子进程注入的，不是持久变量。

| 级别 | 清理前 | 清理后 |
|---|---|---|
| 进程级 | `1` | `[]` ✅ |
| 用户级（持久） | `[]` | `[]` |
| 机器级（持久） | `[]` | `[]`（改需管理员权限，本无值） |

> 注：这只是**不影响**结论的清理 —— 它对「GUI 启动」有意义（否则 Code.exe 以 Node 模式跑），对 picker 无影响。

---

## 二、★ 推翻上一轮的错误结论

上一轮我判断「preset 只在**真实会话**里出现，草稿页看不到」——**用户实测证伪**：真实 DSH 会话下 picker 依然空。

**⇒ 我上轮的「草稿 vs 真实」结论是错的，已从技能里更正。**

---

## 三、真正的根因（bundle 逐环 grep + 真机双证）

### 3.1 两条同名 `getCustomAgents` 是完全不同的东西（核心陷阱）

| # | 位置 | 实际用途 |
|---|---|---|
| **A** | `customizationHarnessService._customAgentsService.getCustomAgents`<br>→ `_getAHSProvider(session)` → `provider.getCustomAgents(sessionId)` | 只喂 `_initAgent` 做**「恢复已选 agent」**匹配<br>**完全不渲染下拉** |
| **B** | `agentHost harness.itemProvider.provideCustomAgents(o,e)`<br>`= (await promptsService.getCustomAgents(e)).filter(n => rw(n.sessionTypes, Li(o)))` | ★★★ **picker 下拉项的唯一真源** |

**我此前所有工作（桥的 `agent/list`、provider 的 `getCustomAgents` 覆盖、agent-host 侧探针）都在 A 路径上 —— 与 UI 显示无关。**

这解释了那个困惑：「探针全绿（`cacheN=5`、`DOP` 正常、provider 表正确）但 UI 恒空」。

### 3.2 picker 真源的完整链路

```js
// ① provider 必须暴露 sessionTypes（VS Code 收集它们）
_collectSessionTypes(){ for (p of getProviders()) for (n of p.sessionTypes) 收集 }

// ② 每个 sessionType 注册一个 scheme resolver（'agent-host-' + id）

// ③ ★ picker 真源
provideCustomAgents(o, e){                 // o = 会话 resource
  let t = Li(o);                           // = 会话 scheme = provider id = "agenthost-dsh"
  return (await promptsService.getCustomAgents(e))     // ← VS Code 自己的 prompt 文件发现！
           .filter(n => rw(n.sessionTypes, t))
}
function rw(s, o){ return s===void 0 || o===void 0 || s.includes(o) }
// ★★ 关键：agent 文件「不写 sessionTypes」⇒ undefined ⇒ 放行（所有 provider 可见）
```

**⇒ 结论：要让 preset 出现在 picker，必须把 preset 落盘成 `*.agent.md` 文件（VS Code 能发现的 agent 文件），而不是靠桥暴露数据。**

---

## 四、★ 修复：落盘 `*.agent.md`（实测 5/5 命中）

### 4.1 关键路径（官方文档 + 实测）

**VS Code 官方文档**（`custom-chat-modes`，2026/10/7）明确：

> **对于运行在 Agent Host 上的会话，用户级自定义代理从 `~/.copilot/agents` 或 `~/.claude/agents` 读取，
> 而不是从 VS Code 配置文件的用户数据中读取。**

| 范围 | 路径 | 本机实测 |
|---|---|---|
| **用户级** | `C:\Users\liuyue\.copilot\agents` | ✅ **有效（5/5 命中）** |
| 工作区级 | `<workspace>\.github\agents` | ❌ **无效** |

**为什么工作区级无效**：Agents 窗口用的是专用工作区文件
`%APPDATA%\Code\User\agent-sessions.code-workspace`，内容为 `{"folders": []}` ——
**没有任何工作区文件夹，所以 `.github/agents` 从不被扫描。**

### 4.2 产物

**生成脚本**：`temp/dsh-ahp-bridge/bridge/tools/gen-preset-agents.mjs`
```bash
node tools/gen-preset-agents.mjs              # dry-run 预览
node tools/gen-preset-agents.mjs --write      # 落盘（不带 sessionTypes ⇒ 所有 provider 可见）
node tools/gen-preset-agents.mjs --scope=dsh --write   # 加 sessionTypes: ["agenthost-dsh"] 收窄
```

**已落盘文件**（用户级 + 工作区副本各一份）：

| 文件 | name | 来源 |
|---|---|---|
| `dsh-standard.agent.md` | 标准模式 | shipped |
| `dsh-ptc.agent.md` | PTC 模式 | shipped |
| `dsh-minimal.agent.md` | 极简模式 | shipped |
| `dsh-cordis.agent.md` | 创作者模式 | shipped |
| `dsh-liangshen.agent.md` | 梁神 | 第三方 `@linxin666/dsh-liangshen` |

### 4.3 验证结果 ✅

```
agent picker 下拉项 =
  ["Agent", "标准模式", "创作者模式", "极简模式", "梁神", "PTC 模式", "配置自定义 Agent..."]

=== 判定 === ✅ 命中 5/5: 标准模式, PTC 模式, 极简模式, 创作者模式, 梁神
```

**且在 DSH 会话下**（会话类型 picker 显示 `DSH (DeepSeek Harness)`）。

---

## 五、注入侧同步改动

`inject-snippet.mjs` 新增 provider 的 `sessionTypes` getter（对齐 VS Code 契约）：

```js
Object.defineProperty(base, "sessionTypes", {
  get: () => [{ id: ID, label: "DSH (DeepSeek Harness)" }],
});
Object.defineProperty(base, "onDidChangeSessionTypes", { value: () => ({ dispose() {} }) });
```

日志确认生效：`[dsh-bridge] sessionTypes exposed: id=agenthost-dsh n=1`

> ★ **踩坑**：初版把这段放在 `const log` **之前**，`log` 处于 TDZ ⇒ 抛错被 catch 吞掉、静默失效。
> 已移到 `log` 定义之后。**这是「有 catch 就有静默」的又一例**。

---

## 六、★ 语义局限（需要你知情）

落盘 agent 文件让 preset **出现在 picker 里**，但要注意：

| 能做到 | 做不到 |
|---|---|
| ✅ preset 显示、可选中 | ❌ **选中后不会传回 DSH 桥**（AHP 桥收不到这个选择） |
| ✅ 与 DSH 会话并存 | ❌ 不会自动切换 DSH 的 preset 行为 |

**⇒ 它本质是 VS Code 侧的「agent 模式」标签。** 要让「选了就生效」，需要 DSH 侧配合（例如给每个 preset 起独立 acp profile `acp-<preset>`，或在桥侧读 `setAgent` 的值再做映射）。

桥的 `setAgent` 注入已经存在（记录 `_selectedAgents`），**理论上可以接上** —— 如果你要打通这一环，我可以继续做。

---

## 七、新增技术要点（已进技能 §32）

1. **CDP 点 VS Code 自定义下拉必须用真实鼠标事件**：
   `el.click()` 无效（monaco-dropdown 监听 `mousedown`）；
   要用 `Input.dispatchMouseEvent` 发 `mousePressed` + `mouseReleased`。
2. **agent picker 的真实选择器**：`.chat-input-picker-item a.action-label[aria-haspopup="true"]`，
   类名是 **`chat-mode-picker-item`**（**不存在** `chat-agent-picker-item` —— 我曾按后者找，白费 3 轮）。
3. 输入区 5 个 picker 标签文本依次为：`本地` / `Agent` / `Auto` / `配置` / `默认权限`。
4. **Agents 窗口的工作区 `folders` 为空** ⇒ 工作区级配置对它一律无效。

---

## 八、回归测试（全绿）

| 测试 | 结果 |
|---|---|
| `e2e-routeB.mjs` | ✅ 7/7 PASS |
| `e2e-bridge.mjs` | ✅ 10/10 PASS |
| `audit-presets-discovery.mjs` | ✅ 5 presets |
| `audit-agent-list.mjs` | ✅ PASS |
| **`verify-preset-loose.mjs`（活体）** | ✅ **5/5 preset 命中** |

---

## 九、文件清单

**新增**
- `tools/gen-preset-agents.mjs` —— preset → agent.md 生成器
- `~/.copilot/agents/dsh-*.agent.md` × 5 —— ★ 生效路径
- `.github/agents/dsh-*.agent.md` × 5 —— 工作区副本（当前无效，备用）
- `test/verify-preset-loose.mjs` / `verify-preset-agents-live.mjs` / `verify-modepicker-click.mjs` /
  `verify-realclick-picker.mjs` / `verify-agentmode-picker.mjs` / `verify-agentpicker-dom.mjs` /
  `verify-agentpicker-expand.mjs` / `probe-agents-view.mjs` / `probe-workspace.mjs` / `probe-promptshome.mjs`

**修改**
- `src/inject-snippet.mjs` —— 新增 `sessionTypes` getter（+ 位置修正）
- `~/.workbuddy/skills/vscode-ahp-harness-integration/SKILL.md` —— 新增 §32、更正 §31.5/§31.6
