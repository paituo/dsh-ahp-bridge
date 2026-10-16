# dsh-ahp-bridge

> 把 **DeepSeek Harness（DSH）** 以**原生 agent host** 形态接入 **VS Code Agents 窗口**的桥接实现。
> 对外扮演 codex app-server，对内驱动 DSH 的 ACP profile。

---

## 这是什么

VS Code 的 Agents 窗口只认一种后端协议：**codex app-server**（OpenAI Codex 的
JSON-RPC over stdio 契约）。本桥做的是一件事：

```
VS Code Agents 窗口
      │  （把桥当成 codex app-server，JSON-RPC over stdio）
      ▼
┌─────────────────────┐
│   dsh-ahp-bridge    │  ← 本仓库
│  （双向协议翻译）    │
└─────────────────────┘
      │  （spawn `dsh --profile acp`，ACP over stdio）
      ▼
DeepSeek Harness（DSH）
```

桥不做业务逻辑，只做**协议翻译 + 能力桥接**：把 codex app-server 的请求翻成 ACP 调用，
把 ACP 的 update 流翻回 codex 的 notification / item 生命周期。

---

## 为什么需要它

Codex（以及所有基于 `codex-app-server` 契约的客户端）本身是闭源二进制。要让 DSH
这种"另一个 agent 运行时"接进来，有两条路：

| 路线 | 做法 | 结论 |
|------|------|------|
| **A. 源码注入** | patch `agentHostMain.js`，撬开内置 codex 的协议处理 | ❌ 脆弱，随 VS Code 升级失效 |
| **B. SDK 顶替（本方案）** | 用启动器把"codex SDK 的入口"替换成本桥 | ✅ 目前生效方案 |

本仓库即**路线 B**的桥本体。配套的启动器（`codex-ext`）与运行时目录不在本仓库内，
见下文「运行前提」。

---

## ⚠️ 运行前提（重要）

桥**不能独立运行** —— 它是被宿主进程 spawn 的。完整运行链需要：

| 组件 | 作用 | 是否在本仓库 |
|------|------|--------------|
| `bridge/src/*.mjs` | 桥本体（本仓库） | ✅ |
| `launcher.conf` | 声明 `NODE_EXE` / `BRIDGE_SCRIPT` / `DSH_BIN` / `BRIDGE_CWD` | ❌ 运行时侧 |
| `codex-ext.exe` | Unicode 启动器（ANSI↔UTF-16 桥接，处理中文路径） | ❌ 运行时侧 |
| `runtime/node/` | 受控 Node 运行时 | ❌ 运行时侧 |
| DSH 安装（`dsh/lib/bin.js`） | 被驱动的 agent 运行时 | ❌ 需自行安装 DSH |

`launcher.conf` 形如：

```ini
NODE_EXE=E:\...\runtime\node\node.exe
BRIDGE_SCRIPT=E:\...\dev\dsh-ahp-bridge\bridge\src\bridge.mjs
DSH_BIN=E:\...\dev\dsh\lib\bin.js
BRIDGE_CWD=E:\...\dev
PROVIDER_ID=dsh
```

---

## 目录结构

```
src/                 桥本体（19 个模块，仅用 Node 内置模块，零外部依赖）
├── bridge.mjs              ★ 主入口：RPC 分发 + 双向翻译编排
├── method-names.mjs        两侧协议方法名常量（翻译契约的真源）
├── translate.mjs           ★ ACP ⇄ codex 的核心翻译层
├── transcript.mjs          DSH 转录读取（多帧 zstd）+ 轮次边界提取
├── dsh-acp-client.mjs      ACP 客户端（NDJSON over stdio）
├── rpc.mjs                 JSON-RPC 端点（stdio）
├── errors.mjs              错误分类与出站错误通道
├── discovery.mjs           技能 / MCP / 会话元数据发现
├── presets.mjs             agent preset 发现
├── profile-patch.mjs       DSH profile 补丁（BYOK / 权限模式）
├── permission-mode.mjs     三轴权限（审核 / 交互 / 沙箱）
└── worktree.mjs            git worktree 隔离

test/                测试与审计脚本
├── unit-*.mjs              单元测试（16 套件）
├── audit-*.mjs             契约审计（把官方 schema 当断言）
├── e2e-*.mjs               端到端（需真实 DSH 进程）
└── verify-*.mjs            真机验证

tools/               运维与探针工具
docs/                根因定案与实施记录
```

---

## 快速开始

```bash
# 1) 需要一个 DSH 安装（提供 dsh/lib/bin.js）
# 2) 直接跑（桥会等待 stdio 上的 JSON-RPC）
node src/bridge.mjs --dsh-bin <path/to/dsh/lib/bin.js> --node <node.exe> --cwd <workspace>

# 3) 跑单元测试（无需 DSH）
node test/unit-remaining-capabilities.mjs
node test/unit-history-turns.mjs

# 4) 契约审计（把官方 schema 当断言源）
node src/audit-remaining-capabilities-contract.mjs
node src/audit-turn-notify-contract.mjs
```

---

## 核心设计要点

### 1. 官方 schema 是唯一权威
所有 codex 侧结构（`Turn` / `ThreadItem` / notification）均严格对齐
`openai/codex` 导出的 JSON Schema。审计脚本把这套 schema 直接当断言。

### 2. item 生命周期不可省
codex renderer 对"没打过招呼的 delta"**静默丢弃**：

```ts
const partId = state.itemToPartId.get(params.itemId);
if (!partId) return [];   // 无 item/started ⇒ 丢弃，且无任何报错日志
```

所以每条文本流都必须 `item/started` → `delta` → `item/completed` 三段式。

### 3. 轮次边界以转录真值为准
DSH 的 `turn/start` / `turn/end.reason.kind` 是权威边界。桥按**轮次号**分组，
而非"顺序配对"（后者在长 agentic 轮上会严重过分裂 —— 实测一轮可含 273 条
`assistant/message`）。

---

## 相关文档

`docs/` 下为逐次根因定案，建议按时间序阅读：

- `定案-发送后无任何消息返回-agentMessage生命周期-20261016.md`
- `定案-选择的模型与实际调用不一致-模型歧义-20261016.md`
- `定案-剩余能力补齐-usage与reasoning与turnBoundary-20261017.md`

---

## 许可

内部工程实现。引用到的第三方协议（codex app-server / ACP）版权归各自所有者。
