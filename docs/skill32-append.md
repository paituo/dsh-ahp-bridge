
---

## 32. ★★★★ 终极真相：agent picker 的 preset 来自 `promptsService`（agent 文件），**不是** AHP provider 的 `getCustomAgents`（2026-10-11 深夜）

> **背景**：§31.5/§31.6 曾判断「草稿 vs 真实会话」是关键 —— **该结论是错的**（用户实测：真实 DSH 会话下 picker 依然空）。
> 本节是逐环 `grep` bundle + 真机验证后的**最终、可复现答案**。

### 32.1 两条 getCustomAgents 是**不同的东西**（最大的认知陷阱）

bundle 里有两个同名方法，此前一直混淆：

| # | 位置 | 实现 | **用途** |
|---|---|---|---|
| **A** | `customizationHarnessService._customAgentsService.getCustomAgents(e)` | `_getSession(e)` → `_getAHSProvider(t)` → `i.getCustomAgents(t.sessionId)` | 只喂 `_initAgent` 做**「恢复已选 agent」**匹配（`Xyn(l,t,u)` 查表）—— **不渲染下拉** |
| **B** | `agentHost harness.itemProvider.provideCustomAgents(o,e)` | `(await promptsService.getCustomAgents(e)).filter(n => rw(n.sessionTypes, Li(o)))` | ★ **这才是 picker 下拉项的数据源** |

我们的注入覆盖的是 **A**（agent-host 侧 provider 的 `getCustomAgents`）——
**它对下拉列表毫无影响**。这就是「探针全绿（cacheN=5、DOP 正常）但 UI 恒空」的原因。

### 32.2 picker 下拉项的完整数据链（逐环实证）

```js
// ① 会话类型收集 —— provider 必须暴露 sessionTypes 字段
_collectSessionTypes(){
  let e=[], t=new Set;
  for (let i of this.sessionsProvidersService.getProviders())
    for (let n of i.sessionTypes) t.has(n.id)||(t.add(n.id), e.push(n));
  return e
}
// 契约（bundle 内 oY/jSe 实证）：{ id, label, icon?, authRequirement? }
// ★ provider 若**不暴露** sessionTypes ⇒ 收不到（但 picker 仍可能显示别的 agent，见 ③ 的 undefined 放行）

// ② 每个 sessionType 注册 scheme resolver
let g = 'agent-host-' + h.id;   // 注意：这里拼的是 agent-host-<sessionTypeId>

// ③ ★ picker 真源
provideCustomAgents(o, e){                 // o = 会话 resource
  let t = Li(o);                           // Li(s) = s.scheme（默认取 scheme 本身）
  return (await this.promptsService.getCustomAgents(e))
           .filter(n => rw(n.sessionTypes, t))
}
function rw(s, o){ return s===void 0 || o===void 0 || s.includes(o) }
// ★★ 关键：agent 文件**不写** sessionTypes ⇒ rw(undefined, ...) = **true** ⇒ 放行！
//    写了 sessionTypes ⇒ 必须 includes(会话 scheme) 才显示。

// ④ picker 渲染（真正把 agent 变成下拉项的在这里）
refreshCustomPromptModes(e){
  let i = await this.customizationHarnessService.getCustomAgents(this.sessionResource, e);
  for (let r of i){
    if (!r.visibility.userInvocable || !r.enabled) continue;   // 过滤条件
    let c = this._customModeInstances.get(r.uri.toString()); ...
  }
}
```

### 32.3 ★ 修复方案：落盘 `*.agent.md`（实测 5/5 命中）

**官方文档**（<https://code.visualstudio.com/docs/copilot/customization/custom-chat-modes>，2026/10/7）明确：

> **对于运行在 Agent Host 上的会话，代理从所选主机的文件夹（如 `~/.copilot/agents` 或 `~/.claude/agents`）
> 读取用户级自定义代理，而不是从 VS Code 配置文件的用户数据中读取。**

| 范围 | 路径 | 有效性（本机实测） |
|---|---|---|
| **用户级（Agent Host）** | `~/.copilot/agents` 或 `~/.claude/agents` | ✅ **有效**（5/5 命中） |
| 工作区级 | `<workspace>/.github/agents`（或 `.claude/agents`） | ⚠️ 仅当工作区有 folders；**Agents 窗口默认 `folders: []` ⇒ 无效！** |
| 插件级 | `<globalStorage>/<ext>/<name>-agent/`（如 Copilot 的 Ask/Plan） | — |

**★ Agents 窗口的工作区是 `%APPDATA%/Code/User/agent-sessions.code-workspace`，默认 `{"folders":[]}`** ——
所以**工作区级 `.github/agents` 在 Agents 窗口里根本不生效**，必须用**用户级 `~/.copilot/agents`**。

**文件格式**（frontmatter，参照 Copilot 真机样例 `Ask.agent.md`）：
```markdown
---
name: 标准模式
description: 处理代码、文件和资料，适合大多数任务。
argument-hint: DSH preset: standard
target: vscode
---            ← sessionTypes 可省略（省略=所有 provider 可见）；要收窄写 sessionTypes: ["agenthost-dsh"]
# 正文...
```
- 支持字段：`name` / `description` / `argument-hint` / `tools` / `agents` / `model` /
  `user-invocable` / `disable-model-invocation` / `target` / `handoffs` / `hooks`
  （另 bundle 内部还支持 `sessionTypes`，官方文档未列）
- 生成脚本：`tools/gen-preset-agents.mjs`（`--write` 落盘；`--scope=dsh` 加 sessionTypes）

### 32.4 ★ 语义局限（必须向用户说明）

落盘 `*.agent.md` 让 preset **出现在 picker 里**，但：
- 它本质是 **VS Code 侧的「agent 模式」标签**，**选中后不会传回 DSH 桥**（AHP 桥收不到该选择）；
- 真正启用 DSH preset 仍需在 **DSH 侧**切换（`dsh --profile <preset>` 或 DSH UI）。
- ⇒ 若要做到「选了就生效」，需要 DSH 侧配合（如给每个 preset 起独立 acp profile `acp-<preset>`）。

### 32.5 CDP 点击 VS Code 自定义下拉：**必须用真实鼠标事件**

```js
// ✗ el.click() 无效（VS Code 的 monaco-dropdown 监听 mousedown，且在 capture 阶段）
// ✓ 用 CDP Input.dispatchMouseEvent
const r = el.getBoundingClientRect();
for (const type of ["mousePressed","mouseReleased"])
  await call("Input.dispatchMouseEvent", { type, x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), button:"left", clickCount:1 });
```
**元素定位（★ 曾找错 3 次）**：agent picker 的真实 DOM 是
```html
<li class="action-item chat-input-picker-item chat-mode-picker-item">
  <div class="monaco-dropdown"><div class="dropdown-label">
    <a class="action-label" role="button" aria-haspopup="true" aria-label="Agent">
      <span class="chat-input-picker-label">Agent</span>
```
- 选择器：`.chat-input-picker-item a.action-label[aria-haspopup="true"]`，其 `aria-label` 即当前值
- 类名是 **`chat-mode-picker-item`**（**不是** `chat-agent-picker-item`——后者不存在！）
- 输入区 5 个 picker 标签文本依次为：`本地` / `Agent` / `Auto` / `配置` / `默认权限`

### 32.6 诊断探针：provider 表（agent-host 侧，一行定生死）

```js
// 放在 D.registerProvider(base) 之后，setTimeout 8000ms，用 c.error 强制输出
const P = D._providers;
const ids = P.keys ? [...P.keys()] : (()=>{const a=[];P.forEach(v=>a.push(v&&v.id));return a;})();
c.error("[DIAG] kind=" + (typeof P.get==="function"?"Map":"Set") + " ids=[" + ids.join(",") + "]"
      + " | getProvider(ID)=" + (D.getProvider?.(ID)?.id ?? "undefined"));
// 期望：ids=[copilotcli,agenthost-dsh,claude]
```
★ 探针全绿 **不能证明 picker 会显示** —— 因为 picker 走的是 32.1 的 **B 路径**，与 provider 的 getCustomAgents 无关。

### 32.7 一次跑通的完整验证清单（最终版）

```bash
# 0) 环境
Remove-Item Env:\ELECTRON_RUN_AS_NODE     # ★ 否则 GUI 起不来（见 §31.1）
Start-Process Code.exe --remote-debugging-port=9333 --new-window

# 1) 落盘 preset 为 agent 文件（关键步骤！）
node tools/gen-preset-agents.mjs --write                    # → 工作区 .github/agents（Agents 窗口无效）
cp .github/agents/*.agent.md ~/.copilot/agents/             # ★ 用户级才生效

# 2) 打开 Agents 窗口
node test/cdp-agents-open.mjs

# 3) 验证（切 DSH 会话 → 真实鼠标点 agent picker → dump）
node test/verify-preset-loose.mjs 9333
# 期望 lists 中出现：["Agent","标准模式","创作者模式","极简模式","梁神","PTC 模式","配置自定义 Agent..."]
```

### 32.8 通用教训（与既有铁律同源）

- **「探针全绿」≠「UI 会显示」** —— 我验证的是 A 路径，UI 走的是 B 路径。
  **必须先确定「要观测的现象由哪条链路产生」，再选探针**（否则探针只证明了一个无关的事实）。
- **两个同名方法/两条同名链路并存时，必须逐字节比对调用点**，不能凭名字假设它们是一回事。
- **「配置写进去了」≠「它被识别了」**：`.github/agents` 放对了文件，但 Agents 窗口 `folders:[]` ⇒ 从不扫描。
  **要问「这个位置在**当前这个宿主**的扫描根里吗」**（Agent Host 的用户级 ≠ VS Code 的用户级！）。
