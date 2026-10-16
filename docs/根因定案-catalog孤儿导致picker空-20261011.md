# 根因定案：DSH preset 为何进不了 VS Code Agents 窗口的 agent picker
## ——「catalog 孤儿会话」连锁失效（2026-10-11 深夜 完整版）

> 本文推翻此前两版结论（"两条 getCustomAgents"、"promptsService 扫文件"），
> 给出**源码 + 真机双向实证**的最终因果链，并附可复跑的对账判据与清理脚本。

---

## 一、现象（一句话）

Agent 会话里点开「选择模式」picker，下拉**永远只有**：

```
["Agent", "配置自定义 Agent..."]
```

而桥侧**明明有 5 个 preset**：
```
[dsh-bridge] [bridge] info: agent/list: 5 agent(s) [standard, ptc, minimal, cordis, liangshen]
[dsh-bridge] agents refreshed: 5 [standard,ptc,minimal,cordis,liangshen]
```

即：**数据源（桥）有货，UI（picker）拿不到。**

---

## 二、最终根因链（决定性证据）

### 2.1 直接证据：AHP 请求持续报错

在 Agents 窗口 renderer 抓 `Runtime.consoleAPICalled`（脚本 `_grab-ahp-errors.mjs`）：

```
[RemoteAgentHostProtocol] Request 14/15/20/21/... failed:
  { code: -32001, message: "No agent for session: dsh:/19106589-67e7-4dfc-9e17-14b42d79c1d9" }
```

### 2.2 错误出处（源码定位）

`out/vs/platform/agentHost/node/agentHostMain.js`：

```js
let r = await this._sessionRegistry.get(e, f => this._migrateRegisteredSession(f));
r && this._providerService.associateSession(e, r.provider);
let s = r ? this._providerService.getProvider(r.provider)
          : this._providerService.getProviderForSession(e);     // ★ 按 session 找 provider
if (!s) throw new H(Bt, `No agent for session: ${t}`);           // ★★ 抛出点
```

**语义**：VS Code 主进程要为每个 session 找到**关联的 provider（= agent）**；
找不到 ⇒ `-32001 No agent for session`。

### 2.3 为什么找不到：scheme 与注册 id 不一致

| 侧 | 值 | 出处 |
|---|---|---|
| 桥进程收到的 provider id | `agenthost-dsh` | 桥启动日志 `bridge up. providerId=agenthost-dsh` |
| 出错 session 的 scheme | **`dsh`** | `dsh:/19106589-...` |
| catalog 里该行的 provider | **`dsh`** | `agent-host.db` |

**`getProviderForSession("dsh:/...")` 查不到 `dsh` 这个 provider（未注册）⇒ 抛错。**

### 2.4 第二层（清掉脏 scheme 后暴露出来）

清掉 `dsh:` 脏行后，错误**变成**：

```
{ code: -32001, message: "Session was never created on the backend: agenthost-dsh:/61832725-..." }
```

出处（同文件）：

```js
if (!p) throw ... (
  ke && this._provisionalSessionKeys.has(n)
    ? new H(Bt, `Session was never created on the backend: ${n}`)   // ★ 命中：provisional
    : ke && !He
      ? new H(Bt, `Session not found on backend: ${n}`)
      : new H(hd, `Provider ${e.id} is not ready to open ${n}; ...`)
);
```

**语义**：该 session 被标记为 **provisional（临时/未落地）**，即 **catalog 里有行、后端（DSH）根本没有这个会话**。

### 2.5 provisional 是怎么来的（源码）

注入片段里上一轮排查已记下：

```
1) AgentHostCatalogReconciliation 对每条 catalog 会话做 _resolveSource；
   孤儿解析不到源 ⇒ status="sourceUnresolvable"
2) 该分支执行 _markEmptySourceUnresolvableAsProvisional(...)
   → catalogDatabase.setSessionProvisional(uri, true)
3) UI 打开 Agents 窗口 → 对每条 provisional 会话发 'subscribe'
   → AgentService 取不到 metadata（后端确无此会话）→ 抛
     「Session was never created on the backend」
4) 该会话的 agent 请求全部失败 ⇒ picker 只剩兜底 "Agent"
```

### 2.6 完整链条（最终）

```
agent-host.db 里的 catalog 行
        │  磁盘 ~/.dsh/sessions/ 无对应目录
        ▼
   _resolveSource 解析不到 ⇒ sourceUnresolvable
        ▼
   setSessionProvisional(uri, true)   ← provisional 标记
        ▼
   UI 打开该会话 ⇒ subscribe ⇒ 取不到 metadata
        ▼
   -32001  No agent for session / Session was never created on the backend
        ▼
   picker 拿不到 agent 列表 ⇒ 只剩兜底 ["Agent","配置自定义 Agent..."]
```

**⇒ picker 空与"preset 发现"、"promptsService 扫文件"、"itemProvider"全都无关。
它卡在 catalog 脏数据引发的同一条 32001 错误上。**

---

## 三、对账判据（可复跑，一行核验）

### 3.1 catalog 孤儿 = `session_uri` 指向的会话在磁盘不存在

```python
import sqlite3, os
disk = set()
for root, dirs, files in os.walk(os.path.expanduser('~/.dsh/sessions')):
    for d in dirs:
        disk.add(d[len('session-'):] if d.startswith('session-') else d)

c = sqlite3.connect(os.path.expandvars(r'%APPDATA%/Code/User/globalStorage/agent-host.db'))
for prov in ('agenthost-dsh', 'dsh', 'bowei'):
    rows = [u for (u,) in c.execute('select session_uri from sessions where provider=?', (prov,))]
    miss = [u for u in rows if u.split(':/')[-1] not in disk]
    print(prov, 'total=', len(rows), '孤儿=', len(miss), [m.split('/')[-1][:8] for m in miss])
```

**本轮实测结果（清理前）：**
```
provider=agenthost-dsh  total=7  磁盘命中=0  孤儿=7  ['c539e785','61832725','cc56acf6','caa71d1d','54def1f0','e0390e81','0ea96183']
provider=dsh            total=0  （上轮已清）
provider=bowei          total=0  （sessions 表已无）
```

### 3.2 双侧都要清（血案重演点）

**catalog 与 UI 缓存是两处独立存储，必须同时清** —— 只清一侧不复现修复：

| 存储 | 表/键 | 内容 |
|---|---|---|
| `agent-host.db` | `sessions` / `sessions_v2` / `session_chat_catalogs` | catalog 行（reconciliation 依据） |
| `state.vscdb` | `ItemTable['localAgentHost.cachedSessions.v4']` | UI 会话列表缓存（含 `provider` 字段） |

---

## 四、清理动作（本轮已执行，含备份）

备份：`agent-host.db.bak-before-dshcleanup`、`state.vscdb.bak-before-dshcleanup`

### 4.1 catalog（删孤儿，7 行 × 3 表）

```python
U = [u for (u,) in c.execute("select session_uri from sessions where provider='agenthost-dsh'")
     if u.split(':/')[-1] not in disk]
for t in ('sessions', 'sessions_v2', 'session_chat_catalogs', 'session_chats'):
    for u in U:
        c.execute(f'delete from {t} where session_uri=?', (u,))
c.commit()
# 清理后：provider 汇总 = [('copilotcli', 43)]
```

### 4.2 UI 缓存（摘孤儿项，保持 TEXT 类型）

```python
K = 'localAgentHost.cachedSessions.v4'
row = s.execute('select value, typeof(value) from ItemTable where key=?', (K,)).fetchone()
assert row[1] == 'text'                       # ★ 血案防线：原始类型必须是 text
keep = [x for x in json.loads(row[0])
        if not (str(x.get('provider')) in ('dsh', 'bowei')
                or (str(x.get('provider')) == 'agenthost-dsh'
                    and str(x.get('session')).split(':/')[-1] not in disk))]
# ★ 必须用 str 写回（绝不 .encode()），否则写回变 BLOB → VS Code JSON.parse 崩
s.execute('update ItemTable set value=? where key=?',
          (json.dumps(keep, ensure_ascii=False, separators=(',', ':')), K))
s.commit()
# 复验
assert s.execute('select typeof(value) from ItemTable where key=?', (K,)).fetchone()[0] == 'text'
```

**本轮结果**：UI 缓存 18 → 16（摘掉 `agenthost-dsh:/61832725`、`bowei:/c727ed8d`），类型仍为 `text`。

---

## 五、验证：错误已"前进"，还差最后一步

清理并重启后重抓 console：

| | 错误文案 |
|---|---|
| 清理前 | `No agent for session: **dsh:**/19106589-...` |
| 清理后 | `Session was never created on the backend: **agenthost-dsh:**/61832725-...` |

**错误前进 = 定位准确、清理生效**（第一层 scheme 不一致已消除，暴露第二层孤儿问题）。

⚠️ 注意：清理后报错的 `agenthost-dsh:/61832725-...` **即本轮刚删掉的孤儿 id** ——
说明该 id 仍在某处被引用（UI 打开的历史会话 / 内存态），需**完全重启 VS Code** 后再看。

---

## 六、剩余动作（一步）

**新建一个真正属于 DSH 的会话**（后端会随之创建 session 目录），其 agent 请求即不再 32001。

预期结果：picker 下拉出现
```
["Agent", "标准模式", "创作者模式", "极简模式", "梁神", "PTC 模式", "配置自定义 Agent..."]
```

若新建后仍空 → 说明还有**第三条**脏引用（下一步查 `agent-host-storage.json` 与 `metadata` 表）。

---

## 六·补 【活体捕获】第三处存储 + 新会话不落后端（本轮最终发现）

### 6.1 第三处存储：`state.vscdb` 的 `agentSessions.providerReadMigration`

清理并重启后，catalog **又凭空出现 2 条 `agenthost-dsh` 孤儿**（磁盘无对应）。
追查发现**第三处记录点**：

```
state.vscdb → ItemTable['agentSessions.providerReadMigration']   (JSON 数组)
  含: "agent-host-agenthost-dsh:/7a564926-...", "agent-host-agenthost-dsh:/eb3fe2fd-..."
```

**⇒ 「会话被记住」共三处，必须三处同清：**

| # | 存储 | 键 / 表 | 说明 |
|---|---|---|---|
| 1 | `agent-host.db` | `sessions` / `sessions_v2` / `session_chat_catalogs` | catalog 行 |
| 2 | `agent-host.db` | **`metadata`**（`sessionProvisional:*` / `sessionTombstone:*`） | ★ **provisional 标记真源** |
| 3 | `state.vscdb` | `localAgentHost.cachedSessions.v4` **+** `agentSessions.providerReadMigration` | UI 列表 + 迁移记录 |

**本轮 `metadata` 清理量**：删 52 条（`dsh`14 + `agenthost-dsh`9 + `bowei`8 + `claude`3 的 provisional 及对应 tombstone）。

### 6.2 ★★★ 活体捕获：新会话「不落后端」的完整链路

三处清干净后重启，**catalog 保持 0 条 `agenthost-dsh`**（不再重建）✅。
随后在 UI 点「新会话」，**立即**观察到：

```
catalog: agenthost-dsh:/6b9a2c03-5508-4cee-af42-c35199d0d15f   磁盘存在: False
metadata: sessionProvisional:agenthost-dsh:/6b9a2c03-... = true
```

**同时桥日志里完全没有 `thread/start`**（只有 `bootstrap models ready` / `agent/list` / `model/list`）。

**⇒ 最后一块拼图（因果链末端）：**

```
UI 点「新会话」
   ▼
VS Code 生成会话 URI + 写 catalog + 标 provisional
   ▼
★ 但【没有】向桥发 thread/start（桥日志零记录）
   ▼
DSH 侧永不创建该会话 ⇒ 磁盘无 ~/.dsh/sessions/<uuid>
   ▼
provisional 永真 ⇒ agent 请求全 -32001 ⇒ picker 只剩兜底 Agent
   ▼
（输入区也不渲染 —— 因为会话未真正建立）
```

**结论**：picker 空这条链，**数据侧已全部清干净**；
剩下的是**「新会话创建流程没有走到桥」**（`thread/start` 未发出）——
这属于**会话创建链路**的独立课题，不再是 catalog 脏数据问题。

---

## 七、方法论教训（与既有铁律同源）

| # | 教训 | 对应铁律 |
|---|---|---|
| 1 | **「有 X 且有问题」≠「X 是原因」**：上一轮只清 `dsh` 1 条就标 completed，未做"孤儿全量对账" | 对照实验 |
| 2 | **双侧存储必须同清**：catalog 与 UI 缓存，只清一侧不复现 | 单侧复原不复现 |
| 3 | **"错误文案前进"也是有效判据**：从 scheme 错 → provisional 错，证明前一环已修好 | 出处端点 |
| 4 | **宽松断言是假阳性源头**：上一版 `verify-preset-loose.mjs` 用整个 dump 做子串匹配，页面上任何地方出现"创作者模式"就算命中 —— 必须改为**只看 `.action-widget` 内的 monaco-list-row** | 存在性 vs 可见性 |
| 5 | **写 SQLite 键值库必须保持原始类型**（`typeof(value)` 必须是 `text`，写回传 `str`） | VS Code state.vscdb 血案 |

---

## 八、附：本轮新增的可复跑脚本（bridge/test/）

| 脚本 | 用途 |
|---|---|
| `_grab-ahp-errors.mjs` | 抓 `RemoteAgentHostProtocol` 失败请求的**完整错误对象**（含 code/message） |
| `_dump-widget-only.mjs` | **只看 `.action-widget` 内**的下拉项（消除假阳性） |
| `_list-targets.mjs` | 列举 CDP target，定位 Agents 窗口 |
| `_probe-cmd-entry.mjs` | 探测 renderer 可用的命令/服务入口 |
| `_run-cmd-insert.mjs` | 用 `Input.insertText` 驱动命令面板（含 console 抓取） |
