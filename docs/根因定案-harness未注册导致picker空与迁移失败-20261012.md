# 根因定案：harness 未注册到 CustomizationHarnessService ⇒ picker 空 + 「无法启动代理引导的定制化迁移」

> 日期：2026-10-12
> 现象：① Agents 窗口 agent picker 下拉只有兜底项 `["Agent","配置自定义 Agent..."]`（桥侧明明有 5 个 DSH preset）
>       ② 点「使用 AGENT 迁移」报错 **「无法启动代理引导的定制化迁移」**
> 结论：**两个现象同源** —— 我们只把 provider 注册到了 `agentHost` 的 **provider registry**，
>       却**从未注册到 `CustomizationHarnessService`**；后者才是 picker 与迁移的**唯一数据源**。

---

## 一、决定性证据链（全部来自 bundle 源码 + 运行时日志）

### 1.1 报错文案的出处端点
`out/vs/sessions/sessions.desktop.main.js`：
```js
// startCustomizationMigrationWithAgent()
async startCustomizationMigrationWithAgent(){
  let e = this.harnessService.getActiveDescriptor();     // ← descriptor
  if (x_e(e.id)) return;                                 // 守卫：remote-* 才 return
  ...
  try {
    ...
    let p = await this.commandService.executeCommand(
      `workbench.action.chat.openNewSessionSidebar.${e.id}`,  // ★ 命令名 = 前缀 + descriptor.id
      { prompt: u });
    ...
  } catch(a){
    Ke(a);
    this.notificationService.error(d(11816, null));      // ← 这句！
  }
}
```
- `d(11816)` = **"Could not start the agent-guided customization migration."**（中文即「无法启动代理引导的定制化迁移」）
- **报错落在 `catch`** ⇒ try 块里某步抛异常 ⇒ 最强嫌疑是最后那句 `executeCommand`（`${e.id}` 为空 ⇒ channel 不存在 ⇒ 抛）。

### 1.2 descriptor 从哪来（`CustomizationHarnessService`）
```js
this._activeHarness = de(this, i => Li(this._activeSessionResource.read(i)))  // = session 的 scheme
getActiveDescriptor(){ let o=this._activeHarness.get(); return this.findHarnessById(o) ?? Ixr }
findHarnessById(o){ return this._getAllHarnesses().find(e => e.id === o) }
_getAllHarnesses(){ return [..._staticHarnesses(去重), ..._externalHarnesses] }
var Ixr = { id:"", label:"", icon:D.sparkle }          // ★ 兜底：id 为空字符串！
```
⇒ **若 `_getAllHarnesses()` 里没有匹配 `activeHarness` 的 id ⇒ 返回兜底 `{id:""}` ⇒ 命令名变成 `openNewSessionSidebar.` ⇒ 必抛 ⇒ 报「无法启动」。**

### 1.3 Sessions 窗口专用子类（决定性）
```js
var kst = class extends qqe {                 // qqe = CustomizationHarnessService
  constructor(o){ super([], "", o) }          // ★ staticHarnesses = [] ，activeHarness 初始 = ""
  registerExternalHarness(o){
    let e = super.registerExternalHarness(o);
    // ★ 内置兜底：注册后若 activeHarness 找不到 harness，就把 active session 切到新 harness
    return this.findHarnessById(this.activeHarness.get())
        || this.setActiveSession(this.getSessionResourceForHarness(o.id)), e;
  }
}
```
⇒ **`registerExternalHarness` 是外部 harness 进入 `_getAllHarnesses()` 的「唯一入口」**，且**自带 activate 兜底**。

### 1.4 我们实际做了什么
注入片段尾部（`inject-snippet.mjs`）只有：
```js
D.registerProvider(base);      // ← 注册到 agentHost 的 provider registry（另一套系统！）
log("info", "provider injected: id=" + ID);
```
**全文 grep `registerExternalHarness` = 0 次**；`PREFIX="agent-host-"+ID` 只定义、**从未使用**（死代码）。

⇒ **`CustomizationHarnessService._externalHarnesses` 恒为空**。

### 1.5 运行时日志佐证
- 桥日志 `sessionTypes exposed: id=agenthost-dsh n=1`、`prefix=agent-host-agenthost-dsh`（双前缀，死代码痕迹）
- VS Code `agenthost.log` 里会话 URI = **`agenthost-dsh:/…`**（单前缀）
- 但 **`_getAllHarnesses()` 为空**（无注册）⇒ 上述 URI 的 scheme **匹配不到任何 harness**

---

## 二、因果链（单一根因，两个症状）

```
注入只调 D.registerProvider(base)
  └─ CustomizationHarnessService 从未 registerExternalHarness
       └─ _getAllHarnesses() = _staticHarnesses([]) + [](空) = 空数组
            └─ activeHarness = ""（kst 初值）
                 └─ getActiveDescriptor() = findHarnessById("") ?? Ixr = Ixr{id:""}
                      ├─【症状① picker 空】getCustomAgents: findHarnessById(Li(o)) = undefined
                      │    ⇒ 走 promptsService.getCustomAgents ⇒ 兜底 ⇒ 下拉只剩 ["Agent","配置自定义 Agent..."]
                      └─【症状② 迁移报错】executeCommand(`openNewSessionSidebar.${""}`)
                           = "openNewSessionSidebar." ⇒ 命令不存在 ⇒ 抛 ⇒ catch ⇒ d(11816)
```

---

## 三、旁证（排除法：这些**不是**根因）

| 曾经怀疑 | 为何排除 |
|---|---|
| catalog 脏数据 / provisional | 已三处清干净；**是否清干净都不影响** harness 注册 |
| `canDelegate` 缺失 | agentHost 自动注册路径**硬编码 `canDelegate:!0`**（workbench 14930776）；且我们根本没走到那 |
| `sessionTypes` 未暴露 | 已暴露 `[ID]`；且 `rw(s,o)=s===void 0||o===void 0||s.includes(o)` ⇒ 未声明也放行 |
| `provideSourceFolders` 未实现 | 调用点用了 `?.` + `?? []`，**不会抛** |
| promptsService 扫不到文件 | `chat.agentFilesLocations` 已设；且**它只是兜底路径**，harness 命中时根本不走 |
| `chat.agentFilesLocations` 设置 | 同上，兜底路径的输入 |

---

## 四、修复方向（下一步执行）

**核心动作**：在注入片段里，拿到 `CustomizationHarnessService`（Sessions 窗口下是 `kst`；DI token 在 bundle 内为 `Sc`），
调用 **`harnessService.registerExternalHarness(ourHarness)`**。

`ourHarness` 的形态需匹配 `_getAllHarnesses()` 的消费方式：
```js
{
  id: "agenthost-dsh",                  // ★ 必须与 session scheme / Li(o) 完全一致
  label: "DSH (DeepSeek Harness)",
  itemProvider: <已有的 ip 对象>,        // 必须含 provideCustomAgents / provideChatSessionCustomizations / onDidChange
  // 视需要补齐 descriptor 字段：icon / description / ...
}
```
**取得 token 的可行路径（待验证，按优先级）**：
1. 注入锚点作用域里若可见 `Sc`（`ye(Sc, XFt, 1)` / `ye(Sc, kst, 1)`）⇒ 直接 `m.createInstance(Sc)`。
2. 否则用 `m.invokeFunction` / `m.createInstance` 配合从 registry 反查。
3. 兜底：hook `kst.registerExternalHarness` 原型，或 hook `_getAllHarnesses` 强制追加我们的 harness。

**验收判据（必须可复现）**：
- [ ] 桥日志出现 **我们的 registerExternalHarness 调用回执**
- [ ] `getActiveDescriptor().id === "agenthost-dsh"`（**不再**是 `""`）
- [ ] picker 下拉出现 **5 个 preset**（standard/ptc/minimal/cordis/liangshen）
- [ ] 点「使用 AGENT 迁移」**不再**弹「无法启动…」
- [ ] 命令 `workbench.action.chat.openNewSessionSidebar.agenthost-dsh` **存在**（enabled）

---

## 五、通用教训（与既有铁律同源）

1. **「注册了 provider」≠「注册到了该管这件事的那个服务」**：
   `D.registerProvider`（agentHost provider registry）与 `CustomizationHarnessService`（picker/迁移数据源）
   **是两套独立系统**；只注册一套 = 另一半永远拿不到数据。
   —— 与 memory「存在性 vs 可见性」同源：**存在于 A 系统 ≠ 在 B 系统可见**。
2. **报错在 catch ⇒ 必须找"哪一步抛"**：`d(11816)` 只是兜底文案，
   **真正的失败原因被吞咽**（catch 里 `Ke(a)` 只 log）。定位必须看 try 里的**每一步出口**，而非文案表面。
3. **兜底值会伪装成正常**：`Ixr={id:""}` 让 `getActiveDescriptor()` **不报错、有返回值**，
   只是返回值**语义为空** —— 与「函数返回成功 ≠ 副作用发生」同源。
4. **死代码会误导**：`PREFIX="agent-host-"+ID` 从未使用，却让人以为前缀已处理；
   桥日志里的双前缀 `agent-host-agenthost-dsh` 就是它的"遗照"。
