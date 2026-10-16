# 定案：剩余能力补齐 —— usage_update / reasoning 生命周期 / turnBoundary 权威边界（2026-10-17）

> 承接《定案：发送后无任何消息返回 —— agentMessage item 生命周期缺失（2026-10-16）》。
> 本轮把 `@deepseek-ai/dsh-agent` 暴露的**剩余未接入能力**全部接进桥，并在此过程中
> 挖出并修复了一个**比原计划更严重的缺陷**（顺序配对过分裂 + 位置猜边界虚构终态）。

---

## 零、一句话定案

> 桥此前只消费了 ACP 7 种 update 中的 6 种、只实现了 3 类 ThreadItem 中的 1 类的
> 完整生命周期、且用"顺序配对"猜轮次边界。本轮补齐三件事：
> ① **`usage_update` 通道**（第 7 种 update，此前落 `default` 发 `type:"unknown"` 垃圾 item）；
> ② **reasoning（思考）item 生命周期**（此前裸发 delta ⇒ 与 agentMessage 同款静默丢弃）；
> ③ **`turnBoundary` 权威轮次边界**（`turn/start`/`turn/end.reason.kind` 真值取代启发式）。
> 并在接入 ③ 时发现：**"顺序配对"在长 agentic 轮上根本错误** —— 实测 5 轮被拆成 17 轮；
> 同时**废除了"无轮次号时用位置 `i+1` 猜边界"的回落**（实测虚构出 32 个 `failed`，占全量 failed 的 97%）。

---

## 一、能力缺口清点（先探查，再动手）

### 1.1 ACP update 种类全集（7 种）

核对法（直接 grep 上游产物，不猜）：

```bash
grep -o 'sessionUpdate: *"[a-z_]*"' node_modules/dsh-acp/lib/index.js | sort -u
```

得到 7 种：

| # | kind | 桥此前 | 本轮 |
|---|------|--------|------|
| 1 | `agent_message_chunk` | ✅ 已接 | — |
| 2 | `agent_thought_chunk` | ⚠️ 只发 delta（缺 started） | ★ 补全生命周期 |
| 3 | `tool_call` | ✅ 已接 | — |
| 4 | `tool_call_update` | ✅ 已接 | — |
| 5 | `plan` | ✅ 已接 | — |
| 6 | `available_commands_update` | ✅ 已接 | — |
| 7 | `config_option_update` | ✅ 已接 | — |
| 8 | **`usage_update`** | ❌ **缺失，落 default** | ★ 新增 |

> ★ 教训：`sessionUpdate` 的值域是**上游定义**的，必须去上游产物里枚举，
> 不能靠"我记得有几种"。少一种 ⇒ 静默落 default ⇒ 发垃圾 item（本轮实证）。

### 1.2 `usage_update` 的真实语义（读上游源码定）

DSH `assistantUpdates()` 在**每条 `assistant/message` 之后**追加一条：

```js
{ sessionUpdate: "usage_update", used: <tokenMeter.measure(session).totalTokens>, size: <contextWindow> }
```

⇒ 它表达的是**上下文占用**（used / size），**不是分项账单**。

---

## 二、官方 schema 是唯一权威（第二轮确认）

`dev/codex-protocol-schema/ThreadTokenUsageUpdatedNotification.json`（curl 自 openai/codex 0.157.0）：

```json
{
  "required": ["threadId", "tokenUsage", "turnId"],
  "properties": {
    "tokenUsage": {
      "required": ["last", "total"],
      "properties": {
        "last":  { "$ref": "#/definitions/TokenUsageBreakdown" },
        "total": { "$ref": "#/definitions/TokenUsageBreakdown" },
        "modelContextWindow": { "type": ["integer","null"], "format": "int64" }
      }
    }
  }
}
```

`TokenUsageBreakdown` 的 **5 个 required**：

```
cachedInputTokens, inputTokens, outputTokens, reasoningOutputTokens, totalTokens
```

> ★ 旧实现的违规：只给了 `last` 的 4 个字段、**完全没有 `total`/`totalTokens`/`modelContextWindow`**
> ⇒ 违反 required ⇒ 客户端可能校验失败或字段读空。

### 2.1 reasoning ThreadItem 契约（易错点）

```json
"reasoning": { "required": ["id","type"], "properties": ["id","type","content","summary"] }
```

> ★ **文本走 `content`，不是 `text`** —— 与 `agentMessage`（`required:["id","text","type"]`）不同。
> 写错键名 ⇒ renderer 拿到空思考块（静默、无报错）。

---

## 三、reasoning item 生命周期（与 agentMessage 同款机制）

### 3.1 静默丢弃机制（源码铁证，与 10-16 定案同源）

```ts
const partId = state.itemToPartId.get(params.itemId);
if (!partId) return [];   // 无 started 建映射 ⇒ 丢弃
```

⇒ 桥此前只发 `item/reasoning/textDelta`、**从不发 `item/started`** ⇒ 全部思考内容被丢。

### 3.2 修法

`translate.mjs` 的 `agentThoughtChunk` case 重写为：

```
首见 itemId  ⇒ 发 item/started { item: { type:"reasoning", id, content:<text>, summary:null } }
后续         ⇒ 发 item/reasoning/textDelta
turn 收尾    ⇒ 发 item/completed { item:{ id, type:"reasoning" } }（成功/失败路径都要）
```

- `itemId` 由 `think-<turnId>` 派生（一轮一个思考块，DSH 不细分）；
- "首见"判定走 `ctx.seenReasoningItems`（`Set`），在 `turn/start` 时重置；
- ★ **turn 收尾必须发 completed**：否则 renderer 里思考块永远处于"进行中"。

---

## 四、turnBoundary 权威边界（本轮最有价值的修复）

### 4.1 DSH 转录边界记录全集（实测）

| 记录 | 携带的权威事实 |
|------|----------------|
| `turn/start` | `data.turn`（**1 基**） |
| `turn/end` | `data.turn`、`data.reason.kind` |
| `step/start` \| `step/end` | `data.{turn, step}` |

`reason.kind` 值域（实测）：`completed` / `error` / `max-tokens` / `aborted` / `blocked` / `interrupted`。

### 4.2 `reason.kind` → 官方 `TurnStatus` 映射

| reason.kind | TurnStatus | 理由 |
|-------------|-----------|------|
| `completed` | `completed` | — |
| `error` | `failed` | **只有真错才 failed** |
| `aborted` / `interrupted` / `max-tokens` / `blocked` | `interrupted` | 截断/中止**不是错误**；标 failed 会让 UI 弹红框（误报） |
| 缺失 / 未知值 | **`null`** | ★ 铁律：兜底值必须中性，绝不猜 |

### 4.3 ★ 血案一：顺序配对**根本错误**（过长 agentic 轮被过分裂）

**实测数据**（会话 `...ef5f634239`）：

```
records=1444  assistant/message=273  tool/call=274  turn/start=4  turn/end=4
```

⇒ 一轮里有 **273 条 assistant/message**（长 agentic 轮）。

**旧"顺序配对"逻辑**（单 user + 其后单 assistant = 一轮）：

```
实测 5 轮  →  被拆成 17 轮   ❌
实测 2 轮  →  被拆成 16 轮   ❌
```

**事件轮次归属实测**：

| 记录 | `data.turn` | 说明 |
|------|-------------|------|
| `assistant/message` | **有**权威轮次号（1,2,2,2,…,5） | 可作分组真源 |
| `user/message` | **恒为 `null`**（只有 `source.kind` 可判） | 必须靠 seq 区间补号 |

**修法**：新增 `transcript.mjs::tagEventsWithTurn(events, records)` —— 从 `turn/start`/`turn/end`
的 **seq** 建"轮次号 → 区间"（左开右闭 `(startSeq, endSeq]`），给无号事件按 seq 补号；
早于首轮 start 的归首轮（inbox 接纳早于 turn/start 是正常的）。
`translate.mjs` 分组逻辑随之升级：**有轮次号 ⇒ 按轮次号分组；无 ⇒ 回落顺序配对**。

**修后验证**：端到端 200 会话 → 之前被拆成的 17/16 轮，**正确收敛回 5/2 轮**，boundary 驱动 **100%**。

### 4.4 ★ 血案二：**位置猜边界**虚构终态（本轮新挖出）

**症状**：冒烟测试 `failed 实际 33 vs 期望 1`（32 个多余的 failed）。

**根因**：`translate.mjs` 为兼容旧行为保留了这条回落：

```js
const lookupTurn = (typeof g.turnNo === "number") ? g.turnNo : i + 1;  // ❌ 位置猜
```

当事件**无轮次号**（走顺序配对）却**又**有边界表时，`i + 1`（位置）会去查边界表
（轮次号）。**位置 ≠ 轮次号** —— 一旦号码有洞（某轮只有 system 消息被跳过），
就会把**隔壁轮的终态错标到本组上**。

**实证**（会话 `...3b9a96cffd`）：该会话只有 **1 个 `turn/start` + `turn/end(reason:error)`**
且**无任何 assistant 文本**（纯 API-key 报错轮）—— 这在 `reasonDist` 里应当计入，
但更关键的是另一类：4 条 user 事件全无号、边界恰有 4 轮 ⇒ `i+1` 巧合命中，
把"有内容轮"标成隔壁轮的 `aborted`。**凑巧对了，逻辑不可靠。**

**修法**：**无 `turnNo` 时禁用边界校正，一律走启发式**，并打日志明示：

```js
} else if (bndByTurn.size > 0) {
  statusSource = "heuristic:no-turnno-with-boundaries";
  console.warn(`[translate] 轮次分组无 turnNo 但有边界表（${bndByTurn.size} 轮）⇒ 放弃边界校正…`);
}
```

> ★ 与「兜底值必须中性」「降级分支必须打日志」一脉相承：
> **位置不是身份**。拿位置当身份去查表，是把"猜"伪装成"查"。

**修后验证**（原 400 会话冒烟）：

```
扫描会话 400（有历史 180），回填轮次 246
状态来源：boundary=246  heuristic=0          ← 生产路径 100% 权威边界
reason 分布 : {completed:147, error:64, interrupted:3, max-tokens:3, aborted:5, (无end):24}
status 分布 : {completed:147, failed:64, interrupted:11, inProgress:24}
===== 通过 1060 / 失败 0 =====
```

映射逐项吻合：`error 64 → failed 64` ✅、`interrupted+max-tokens+aborted = 3+3+5 = 11` ✅、
`(无end) 24 → inProgress 24` ✅。

### 4.5 一轮多条 user 的取舍

一轮可含**多条真人 user 消息**（实测 5 轮含 11 条 user）。修法：

- **全部** user 消息都输出为 `userMessage` item（保序）—— 用户输入不应被吞；
- **只输出一条** `agentMessage`（取"最后一条非空"为最终答复）—— 中间过程由
  reasoning / toolCall 通道承载，避免 renderer 生成多个并列气泡（与真实 codex 观感不符）。
- ★ 这是**有意的信息取舍**，已在代码注释明示，**不是 bug**。

---

## 五、改动清单

| 文件 | 改动 |
|------|------|
| `src/method-names.mjs` | `ACP_UPDATE_KIND` 补第 7 种 `usageUpdate` |
| `src/translate.mjs` | ① `translateTokenUsage` 重写（补 schema required 5+2 字段）② 新增 `translateUsageUpdate` ③ `translateSessionUpdate` 加 `usageUpdate` case + `default` 打日志 ④ `agentThoughtChunk` 重写（started/delta/completed 生命周期）⑤ 分组改按 `turnNo` ⑥ **废除位置猜边界** ⑦ 新增 `transcriptRecordsToTurnsAsync`，旧版标 `@deprecated` |
| `src/transcript.mjs` | 新增 `extractTurnBoundaries` / `turnEndReasonToStatus` / `tagEventsWithTurn` |
| `src/bridge.mjs` | ① ctx 加 `seenReasoningItems`（turn/start 重置）② usage 通知透传 `modelContextWindow` ③ turn 收尾补 reasoning `item/completed`（成功+失败两路径）④ `loadHistoryTurns` 改双调用（边界+打标） |
| `dev/codex-protocol-schema/ThreadTokenUsageUpdatedNotification.json` | 官方 schema 落盘（curl openai/codex 0.157.0） |
| `test/unit-remaining-capabilities.mjs` | 新增（59 断言） |
| `src/audit-remaining-capabilities-contract.mjs` | 新增（30 断言） |

**备份**：`translate.mjs.bak-before-boundary-seg-20261017`、`transcript.mjs.bak-before-boundary-seg-20261017`、`bridge.mjs.bak-before-boundary-seg-20261017`。

---

## 六、验证矩阵（全绿）

| 套件 | 结果 |
|------|------|
| `unit-remaining-capabilities.mjs` | **59 / 0** |
| `unit-history-turns.mjs` | **27 / 0** |
| `unit-turn-axes.mjs` | **23 / 0** |
| `unit-threadlist-contract.mjs` | **16 / 16** |
| `unit-transcript.mjs` | **3 / 0** |
| `unit-model-*` / `unit-profile-patch` / `unit-worktree` 等 | 全 EXIT=0 |
| `audit-remaining-capabilities-contract.mjs` | **30 / 0** |
| `audit-turn-notify-contract.mjs` | **24 / 0** |
| `audit-error-report.mjs` | **34 / 0** |
| `audit-resume-idempotent.mjs` | **21 / 0** |
| `audit-skills-contract.mjs` | **16 / 0** |
| **端到端冒烟（400 会话）** | **1060 / 0**，boundary 驱动 **100%** |

---

## 七、可复用铁律（本轮沉淀）

1. **枚举值域去上游产物里数**，不靠记忆（`grep -o 'sessionUpdate: *"[a-z_]*"' … | sort -u`）。
2. **位置不是身份**：拿"第 i 个"去查"第 i 号"的表，是把猜伪装成查。要么有真身份，要么诚实回退。
3. **兜底值必须中性**（`null`，不是"当前时间/当前状态"这类看似合理的动态值）。
4. **降级分支必须打日志** —— 否则永远不知道自己跑在降级路径上。
5. **契约字段键名逐字核对**（reasoning 是 `content` 不是 `text`；`title` 不是 `name`…）。
6. **测试夹具要反映真实数据形态**：夹具写"混合有无号"会导致对**新语义**的误判
   （本轮两个单测因夹具过时而红，改夹具而非改代码）。

---

## 八、落盘

- 真源：`E:\分析数据\DeepSeek-Harness-VSCode\dev\dsh-ahp-bridge\bridge`
- ★ **生效条件：完全退出 VS Code 再启动**（桥随宿主进程加载，热重载不生效）。
