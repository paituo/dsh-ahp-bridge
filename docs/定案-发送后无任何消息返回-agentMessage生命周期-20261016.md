# 定案：发送后无任何消息返回 —— agentMessage item 生命周期缺失（2026-10-16）

> 症状：选自定义 DS4.1，发送后界面**无任何回复**；但可以继续发消息，状态像"已完成"。

---

## 一、一句话定案

> 桥把 ACP `agent_message_chunk` **直接翻成 `item/agentMessage/delta`**，
> 而官方契约要求该通知**必带 `itemId`（required）**、且该 item 必须**先由 `item/started` 建立映射**。
> 桥**三件事全没做**（无 itemId、无 started、无 completed）⇒ VS Code renderer 逐条**静默丢弃** ⇒ 界面永远空白。

---

## 二、官方源码铁证（commit 6d62b1d5da）

### 2.1 消费侧：丢包点（`codexMapAppServerEvents.ts` `mapAgentMessageDelta`）

```ts
const partId = state.itemToPartId.get(params.itemId);
if (!partId) {
    // Got a delta before we saw the corresponding `item/started`.
    // Drop it — Phase 2 is best-effort and the lost text is replaced
    // when `item/completed` arrives with the full `text` field.
    return [];          // ★ 静默丢弃：无任何错误、无任何日志
}
```

### 2.2 建映射点（`mapItemStartedBody`）

```ts
if (params.item.type === 'agentMessage') {
    const partId = generateUuid();
    state.itemToPartId.set(params.item.id, partId);          // ★ 映射的**唯一**建立处
    const separator = state.agentMessagePartCount > 0 ? '\n\n' : '';
    state.agentMessagePartCount++;
    return [{ type: ActionType.ChatResponsePart, turnId: params.turnId,
              part: { kind: ResponsePartKind.Markdown, id: partId,
                      content: separator + (params.item.text ?? '') } }];
}
```

### 2.3 官方 proto（`protocol/generated/v2/*.ts`，在线取自官方仓库）

```ts
// AgentMessageDeltaNotification.ts
export type AgentMessageDeltaNotification =
  { threadId: string, turnId: string, itemId: string, delta: string, };   // ★ itemId REQUIRED

// ItemStartedNotification.ts
export type ItemStartedNotification =
  { item: ThreadItem, threadId: string, turnId: string, startedAtMs: number, };

// ItemCompletedNotification.ts
export type ItemCompletedNotification =
  { item: ThreadItem, threadId: string, turnId: string, completedAtMs: number, };

// ThreadItem.ts —— agentMessage 分支
{ "type": "agentMessage", id: string, text: string,
  phase: MessagePhase | null, memoryCitation: MemoryCitation | null,
  delivery: AgentMessageDelivery | null, questions: AsyncUserInputQuestion[] | null }
```

---

## 三、血案现场（真机日志）

`%APPDATA%\Code\logs\20261016T213326\agenthost.log`：

```
21:33:45.981 turn/start #1099  text="test 123"
21:33:45.982 ← turn/started（0.2ms）          ← 桥回了 started
21:33:45.982 prompt → DSH acp session=3413eb18
21:33:50.020 rpc.notify item/agentMessage/delta   ← ★ DSH 有输出，桥转发了 delta
21:33:50.235 ← prompt ← DSH acp 耗时4253ms
21:33:50.235 turn/completed                        ← 5 秒后判定完成
```

**链路全通 —— 但界面空白。** 原因就在 `item/agentMessage/delta` **没带 `itemId`**，
renderer 查不到 `itemToPartId` ⇒ `return []` ⇒ 丢弃。

---

## 四、修复（两侧各一处）

### 4.1 `translate.mjs` · `translateSessionUpdate` 的 `agentMessageChunk` 分支

```
旧：out.push({ method: agentMessageDelta, params: { threadId, turnId, delta: text } })
新：itemId = u.messageId ?? u.itemId ?? `msg-${turnId}`
    · 首见该 itemId ⇒ item/started { item:{id,type:"agentMessage",text,...}, startedAtMs }
    · 再出现      ⇒ item/agentMessage/delta { threadId, turnId, itemId, delta }
```

**关键**：DSH 的 `agent_message_chunk` **自带 `messageId`**
（`temp/dsh-acp-patched/lib/index.js:650`，值 = `event.data.message.id`）—— 直接用作 codex `item.id`。
且 `assistantUpdates()` 是按**已提交的完整消息**产出（非逐字流），故一块 chunk 携带整段文本。

### 4.2 `bridge.mjs`

| 位置 | 改动 |
|---|---|
| `onSessionUpdate` | `ctx` 增加 `seenAgentItems`（桥侧跨 update 复用的 Set） |
| `turn/start` | `rec.seenAgentItems = new Set()` —— **每轮重置**（防跨轮 messageId 复用漏发 started） |
| `prompt` 完成后 | 为每个已开 item 补 `item/completed { item:{...}, completedAtMs }` 并清空 Set |

---

## 五、验收

| 项 | 结果 |
|---|---|
| `node --check` × 3 源码 | 语法零错 |
| `test/unit-agentmessage-item-lifecycle.mjs` | **7/7**（含"任何 delta 必带非空 itemId"的契约断言） |
| `test/unit-*.mjs` 全量 | **10/10** |
| 合成日志喂收割器 v2 | 3 条裁决全部正确（含 P5 的 DSH 输出判定） |

---

## 六、环境真相（本轮最大副产物）

### 6.1 运行的是 E 盘，不是 C 盘

| | 路径 | bridge.mjs |
|---|---|---|
| **运行（真）** | `E:\分析数据\DeepSeek-Harness-VSCode\dev\dsh-ahp-bridge` | 110 KB ← 主线 |
| 废弃 | `C:\Users\liuyue\WorkBuddy\...\temp\dsh-ahp-bridge` | 81 KB ← 旧副本 |

`E:\分析数据\DeepSeek-Harness-VSCode\runtime\launcher.conf`:
```
BRIDGE_SCRIPT=E:\分析数据\DeepSeek-Harness-VSCode\dev\dsh-ahp-bridge\bridge\src\bridge.mjs
DSH_BIN=E:\分析数据\DeepSeek-Harness-VSCode\dev\dsh\lib\bin.js
```

⇒ 任何改动**必须落到 E 盘**，否则等于没改（本轮踩实）。

### 6.2 桥日志的真实落点

桥 stderr 经 `codex-ext.exe` **直通 VS Code 管道，不写文件** ⇒ 实际落在
`%APPDATA%\Code\logs\<ts>\agenthost.log`（带 `[Codex stderr]` 前缀）。
`bridge/temp/inject-bridge.log` 是旧的直跑日志，**已过期不更新**。

### 6.3 注入层当前**未生效**

VS Code 侧 `agentHostMain.js` = 3,719,450 B（clean 版；注入版应为 3,845,228 B），
标记 0 命中 ⇒ 今天已从「bundle 注入」切到「**SDK root override**」方案
（见 `session-.../codex-switch-backup-20261016/README-基线快照.md`）。

⇒ **决定权 100% 在 VS Code 原生 renderer** ⇒ 桥必须严格产出符合官方 proto 的通知。

### 6.4 DSH `exited (code=0)` 不是本轮主因

`21:33:27.811` 实例1 up → `21:33:29.814` host closed（VS Code 重连）→
`21:33:35.011` DSH 因 stdin EOF 正常退出（code=0）→ 实例1 的 `.finally()` 打印
`dsh disposed; exiting bridge` + `uptime=7s`。
**实例2（PID 27268，21:33:29 起存活）一直健康**，21:36+ 仍持续响应 `thread/read`。
⇒ 用户症状与 DSH 退出**无关**，纯属 delta 被丢。

---

## 七、探针（本次新增，可复用）

| 打点 | 位置 | 抓什么 |
|---|---|---|
| P1 REQ/RESP | `dsh-acp-client.mjs` `newSession()` | 请求体（`hasModelField=false`）+ DSH 回执 `currentModel` |
| P2 | `dsh-acp-client.mjs` `prompt()` | 真正发出那一轮的时机 |
| **P5** | `bridge.mjs` `onSessionUpdate` | **每条 ACP update 的 kind 与翻译产物** ← 本次破案关键 |

收割：`node tools/harvest-model-probe.mjs [--last]`
（默认自动定位最新 `agenthost.log`）

---

## 八、待验证

重启 VS Code（**完全退出**再开）→ 新建会话选 DS4.1 → 发一条消息。预期：
1. 界面**正常显示回复文本**；
2. `agenthost.log` 出现 `[probe-turn] ... kind=agent_message_chunk ... → [item/started]`；
3. 收割器 `[3]` 判定显示 "DSH 确实回传了助手文本"。
