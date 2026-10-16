#!/usr/bin/env node
/**
 * P3 路径离线模拟 —— 「tt 壳 + 桥改道」的可行性验证（不碰 bundle）
 *
 * 验证目标：证明下面这套改道逻辑在**纯 JS 语义层**成立：
 *   1) base = createInstance(tt)           → 一个完整、已通过所有初始化器的 provider 实例
 *   2) base.id = "dsh"                     → 新 id（不与 sO 冲突）
 *   3) base.getDescriptor = () => {...}    → 下拉显示 dsh
 *   4) base.chats.sendMessage = 改道到桥    → 消息走 DSH
 *   5) base._models 指向桥上报的模型        → 模型来自 DSH
 *
 * 做法：用一个**模仿 bundle 类结构**的最小假类来验证「实例字段可定向替换」这一语义前提，
 *       再用真实桥的 `model/list` 验证模型数据流。
 *
 * 用法: node test/sim-p3-reroute.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, "..", "src", "bridge.mjs");
const NODE = process.env.BRIDGE_NODE || process.execPath;
const DSH_BIN = process.env.DSH_BIN || "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";
const CWD = process.env.BRIDGE_CWD || process.cwd().replace(/\\/g, "/");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

// ---------------------------------------------------------------- helpers（提前定义，避免 TDZ）
function makeObservable(owner, init) {
  let v = init;
  const em = { _ls: new Set() };
  return {
    get: () => v,
    set: (nv) => { v = nv; for (const f of em._ls) f(nv); },
    onDidChange: (f) => { em._ls.add(f); return { dispose: () => em._ls.delete(f) }; },
  };
}

class RpcClient {
  static spawn(argv) {
    return new Promise((res, rej) => {
      let c;
      try { c = new RpcClient(argv); } catch (e) { rej(e); return; }
      setTimeout(() => res(c), 300);
    });
  }
  constructor(argv) {
    this.pending = new Map(); this.nextId = 1; this.buf = "";
    this.child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", () => {});
    this.child.stdout.on("data", (chunk) => {
      this.buf += chunk; let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined) { const p = this.pending.get(msg.id); if (p) { this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.code + ": " + msg.error.message)) : p.resolve(msg.result); } }
      }
    });
  }
  _ready(res) { setTimeout(res, 300); }  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++; this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 60000);
    });
  }
  dispose() { try { this.child.kill(); } catch {} }
}

// ---------------------------------------------------------------- ① 语义前提：实例字段可定向替换
console.log("\n[1] 语义前提 —— tt 的 chats/_models 是实例字段，可定向替换");
{
  // 模仿 bundle 里 tt 的结构（this.chats= / this._models=）
  class FakeTt {
    constructor() {
      this.id = "sO";                    // copilotcli 的常量 id
      this.agentHostCapabilities = { workspaceConversion: true };
      this._models = makeObservable(this, []);
      this.chats = {
        prepareTurn: (e, t, n, r) => this._prepareTurn(e, t, n, r),
        createChat: (e, t, n) => this._createChat(e, t, n),
        disposeChat: (e, t) => this._disposeChat(e, t),
        sendMessage: (e, t, n, ...r) => this._sendMessage(e, t, n, ...r),
        abort: (e, t) => this._abortSession(e, t),
        getModel: (e) => this._chatBackings?.get(e?.toString())?.model,
        changeModel: (e, t, n) => this._changeModel(e, t, n),
      };
    }
    get models() { return this._models; }
    getDescriptor() { return { provider: "copilotcli", displayName: "Copilot", description: "", capabilities: { multipleChats: { fork: true, sideChat: true } } }; }
    getProtectedResources() { return []; }
    async authenticate() { return true; }
    // 内部实现（模拟）
    async _prepareTurn() { return { ok: true }; }
    async _createChat() { return { chatId: "copilot-chat" }; }
    async _disposeChat() { return {}; }
    async _sendMessage() { return { via: "copilotcli" }; }   // ★ 原始通道
    _abortSession() { return {}; }
    // ★ 模拟 Copilot 原生 _changeModel → _validateModelSelection 的**抛错行为**
    //   （bundle 实证 @1489070：this._models 里没有该 id 且非空 ⇒ throw）
    async _changeModel(e, t, n) {
      const list = this._models.get();
      if (list.length > 0 && !list.some((x) => x.id === t?.id)) {
        throw new Error("模型 '" + (t?.id) + "' 无法获取。");   // ← 复刻 modelSelectionFailed
      }
      return { changed: true };
    }
  }

  const base = new FakeTt();
  ok(base.chats && typeof base.chats.sendMessage === "function", "实例上有 chats.sendMessage");
  ok(base.models && typeof base.models.get === "function", "实例上有 observable models");

  // —— 执行 P3 改道 ——
  const originalSend = base.chats.sendMessage;
  base.id = "dsh";
  base.getDescriptor = () => ({
    provider: "dsh", displayName: "DSH (DeepSeek Harness)",
    description: "DeepSeek Harness via ACP bridge",
    capabilities: { multipleChats: { fork: false, sideChat: false } },
  });
  let rerouted = null;
  base.chats.sendMessage = (...args) => { rerouted = args; return Promise.resolve({ via: "dsh-bridge" }); };
  base._models.set([{ id: "agent-host-dsh:m1", name: "m1" }], undefined);

  ok(base.id === "dsh", "base.id 改为 dsh");
  ok(base.getDescriptor().provider === "dsh", "descriptor.provider = dsh（下拉显示用）");
  ok(base.chats.sendMessage !== originalSend, "chats.sendMessage 已被定向替换");
  const r = await base.chats.sendMessage("chat-1", "turn-1", [{ type: "text", text: "hi" }]);
  ok(r.via === "dsh-bridge" && rerouted !== null, "sendMessage 走改道后的通道（dsh-bridge）");
  ok(base.models.get()[0].id === "agent-host-dsh:m1", "models observable 反映桥上报的模型");

  // —— 4b) changeModel 改道验证（2026-10-12 真因修复）——
  //   改道前：base.chats.changeModel → this._changeModel → _validateModelSelection → throw（复现报错）
  //   改道后：替换为「解析 + 转桥」实现，**永不抛**，且不再触碰 Copilot 校验。
  {
    // ① 先证明「未改道时确实会抛」——固定住根因
    const beforeReroute = base.chats.changeModel;
    let threwBefore = false;
    try { await beforeReroute("chat-1", { id: "agent-host-dsh:[\"bumen\",\"deepseek-v4.1-flash\"]" }, {}); }
    catch (e) { threwBefore = /无法获取/.test(e.message); }
    ok(threwBefore, "改道前：changeModel 抛 modelSelectionFailed（复刻真机报错）");

    // ② 执行与注入片段同构的改道
    let forwarded = null;
    base.chats.changeModel = async (chatLike, model, ..._rest) => {
      const modelStr = model && typeof model === "object" ? model.id : model;
      forwarded = { chat: String(chatLike), model: modelStr };   // 模拟 req("thread/settings/update", ...)
      return undefined;                                          // ★ 不抛
    };
    const originalChange = base._changeModel;
    let threwAfter = false;
    try { await base.chats.changeModel("chat-1", { id: "agent-host-dsh:[\"bumen\",\"deepseek-v4.1-flash\"]" }, {}); }
    catch (e) { threwAfter = true; }
    ok(!threwAfter, "改道后：changeModel 不再抛错（根除 modelSelectionFailed）");
    ok(base.chats.changeModel !== beforeReroute, "chats.changeModel 已被定向替换");
    ok(forwarded && forwarded.model === "agent-host-dsh:[\"bumen\",\"deepseek-v4.1-flash\"]",
       "changeModel 把模型串（.id）转发给桥（形态供 translateModelSelectionToDsh 解析）");
    ok(typeof originalChange === "function", "Copilot 原生 _changeModel 未被破坏（仅未再被 chats.changeModel 调用）");
  }

  // 其余成员未被破坏
  ok(typeof base.chats.prepareTurn === "function", "其余 chats 成员（prepareTurn）完好");
  ok(typeof base.authenticate === "function", "authenticate 完好（registration 需要）");
  ok(typeof base.getProtectedResources === "function", "getProtectedResources 完好");
}

// ---------------------------------------------------------------- ② 模型数据流：真桥的 model/list
console.log("\n[2] 数据流 —— 真桥的 model/list 能产出可挂到 observable 的模型");
{
  const client = await RpcClient.spawn([NODE, BRIDGE,
    "--node", NODE, "--dsh-bin", DSH_BIN, "--cwd", CWD, "--provider-id", "dsh"]);
  try {
    await client.request("initialize", { clientInfo: { name: "sim-p3", version: "0" } });
    await client.request("thread/start", { cwd: CWD, mcpServers: [] });
    const ml = await client.request("model/list", {});
    const models = ml?.models ?? [];
    ok(models.length > 0, `桥返回模型数 > 0（实际 ${models.length}）`);
    const shaped = models.map((m) => ({ id: m.id, name: m.name, provider: m.provider }));
    // ★ 2026-10-12 双层前缀修复：桥须报**裸 id**，前缀由 VS Code 渲染层补
    //   （对照 copilotcli 报 `hydrafusion` 裸值）。详见 translate.mjs 注释。
    ok(shaped.every((m) => !String(m.id).startsWith("agent-host-dsh:")), "每个模型 id 为裸值（不含 hostPrefix；前缀由 VS Code 补）");
    ok(!!shaped[0]?.id, "模型 id 非空（可直接挂 observable）");
    console.log("    样例:", JSON.stringify(shaped.slice(0, 3)));
  } finally {
    client.dispose();
  }
}

// ---------------------------------------------------------------- ③ 注册唯一性约束
console.log("\n[3] 约束 —— id 唯一（bundle: _providers.has(id) 就 throw）");
{
  const reg = new Map();
  const registerProvider = (p) => {
    if (reg.has(p.id)) throw new Error(`Agent provider already registered: ${p.id}`);
    reg.set(p.id, p);
  };
  registerProvider({ id: "copilotcli" });
  registerProvider({ id: "dsh" });
  ok(reg.size === 2, "copilotcli 与 dsh 可共存");
  let threw = false;
  try { registerProvider({ id: "dsh" }); } catch { threw = true; }
  ok(threw, "重复注册 dsh 会抛错（符合 bundle 行为）");
}

console.log(`\n结果: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
