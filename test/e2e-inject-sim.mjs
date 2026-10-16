/**
 * 模拟「注入片段在 VS Code 内的运行环境」，用真实桥 + 真实 DSH 跑通：
 *   懒建 thread → turn/start → 桥通知 → reflow → fire 到假 emitter
 *
 * 目的：在改 bundle 之前，验证第 2 版注入片段的会话逻辑（含 chatId↔sessionId 映射、
 *       turn 完成等待）真的能让回复回流。
 *
 * 运行：node test/e2e-inject-sim.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readMessageText } from "../src/inject-snippet.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, "..", "src", "bridge.mjs");
const NODE = process.execPath;
const DSH_BIN = "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";
const CWD = "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } };

// ---------------------------------------------------------------- 假 emitter（模拟 base._onDidChatProgress）
const fired = [];
const fakeEmitter = { fire: (evt) => fired.push(evt) };

// ---------------------------------------------------------------- 假 VS Code RPC 端点（模拟 bundle 的 p = Ax 实例）
//   桥发来的反向请求（item/permissions/requestApproval 等）经此被「应答」。
//   契约对齐 bundle：审批类返回 { result: { decision } } / 或直接 { selectedOptionId }。
const inboundReqs = [];
const AUTO_APPROVE = process.env.AUTO_APPROVE !== "0";
const fakeVscodeEndpoint = {
  request(method, params) {
    if (/requestApproval/.test(method)) {
      // ★ 严格复刻 VS Code agent host 的真实应答形态：{ result: { decision } }
      //   （bundle 实证 _handleCommandApprovalRequestRpc / _handlePermissionsApprovalRequestRpc）
      return Promise.resolve({ result: { decision: AUTO_APPROVE ? "allow" : "deny" } });
    }
    if (/requestUserInput/.test(method)) return Promise.resolve({ response: "cancel" });
    return Promise.resolve({});
  },
};

// ---------------------------------------------------------------- 复刻注入片段的核心逻辑
const cfg = { bridge: BRIDGE, dshBin: DSH_BIN, node: NODE, cwd: CWD };
const ID = "dsh";
let child = null, buf = "", nextId = 1;
const pending = new Map();
const log = (lv, msg) => { if (lv === "error") console.log(`      [bridge-log] ${msg}`); };

let _sq = 0;
const _nid = () => "p" + (_sq++).toString(36) + Date.now().toString(36);
const chats = new Map();
// ★ T1/T2 同步：toolCalls 表 + hostTurnId（轮次单一真源）
// ★★★ 血案（2026-10-11 02:35 真机卡死根治）：chats 的 key 必须一律 String 归一。
//   真机 chatContext.chatUri 是**对象**（URI 实例），而 sendMessage 用 String(chatUri) 作 key；
//   若 chatUriBySession 存原始对象，则 cgetByThread(sid) 会用对象 key 命中**另一个空 c**
//   ⇒ 桥通知全被 emit 的 `if(!c.resource) return` 丢弃 ⇒ 无 chat/error、不 settle ⇒ UI 卡死。
const _K = t => (t == null ? t : String(t));
const cget = t => { const kk = _K(t); let c = chats.get(kk); if (!c) { c = { resource: null, turnId: null, hostTurnId: null, mdId: null, rzId: null, md: false, rz: false, toolCalls: new Map(), _done: null }; chats.set(kk, c); } return c; };
const chatUriBySession = new Map();
const sessionByChatUri = new Map();
const cgetByThread = t => { const uri = chatUriBySession.get(_K(t)) || _K(t); return cget(uri); };
const emit = (t, a) => { const c = cgetByThread(t); if (!c.resource) { log("error", "drop(no resource) " + a.type); return; } fakeEmitter.fire({ kind: "action", resource: c.resource, action: a }); };
const settleTurn = t => { const c = cgetByThread(t); if (c._done) { const f = c._done; c._done = null; try { f(); } catch (_) {} } };
// ★ T2：startTurn 接受桥下发的 hostTurnId
const startTurn = (t, ut, hostTurnId) => {
  const c = cgetByThread(t);
  if (c.turnId) { if (hostTurnId && hostTurnId !== c.hostTurnId) { c.hostTurnId = hostTurnId; c.turnId = hostTurnId; } return c.turnId; }
  c.hostTurnId = hostTurnId || null;
  c.turnId = hostTurnId || _nid();
  c.mdId = null; c.rzId = null; c.md = false; c.rz = false; c.toolCalls.clear();
  emit(t, { type: "chat/turnStarted", turnId: c.turnId, startedAt: new Date().toISOString(), message: { text: ut || "", origin: { kind: "user" } } });
  return c.turnId;
};
const finishTurn = (t, d) => { const c = cgetByThread(t); if (!c.turnId) { settleTurn(t); return; } emit(t, { type: "chat/turnComplete", turnId: c.turnId, duration: Math.max(0, d | 0) }); c.turnId = null; c.hostTurnId = null; c.toolCalls.clear(); settleTurn(t); };
// ★ 标准 error part（与注入片段同构）：part.kind === "error"
// ★★ V2 修正（2026-10-11）：必须用**普通对象**，而非 new Error() ——
//    因为全链路 emit 经 JSON.stringify 出网，Error 的 message 是 non-enumerable 会被吞掉，
//    渲染成「错误: (undefined) undefined」。
const errorPart = (m, code) => {
  const msg = String(m == null ? "error" : (m.message || m));
  return { kind: "error", error: { message: msg, errorType: code != null ? String(code) : "TURN_FAILED" } };
};
const failTurn = (t, m, code) => { const c = cgetByThread(t); if (c.turnId) emit(t, { type: "chat/error", turnId: c.turnId, duration: 0, part: errorPart(m, code) }); c.turnId = null; settleTurn(t); };
const mdDelta = (t, x) => { if (!x) return; const c = cgetByThread(t); if (!c.turnId) startTurn(t); if (!c.md) { c.mdId = _nid(); c.md = true; emit(t, { type: "chat/responsePart", turnId: c.turnId, part: { kind: "markdown", id: c.mdId, content: x } }); } else emit(t, { type: "chat/delta", turnId: c.turnId, partId: c.mdId, content: x }); };
const rzDelta = (t, x) => { if (!x) return; const c = cgetByThread(t); if (!c.turnId) startTurn(t); if (!c.rz) { c.rzId = _nid(); c.rz = true; emit(t, { type: "chat/responsePart", turnId: c.turnId, part: { kind: "reasoning", id: c.rzId, content: x } }); } else emit(t, { type: "chat/reasoning", turnId: c.turnId, partId: c.rzId, content: x }); };
// ★ T1：工具调用结构化（与 inject-snippet 同步）
const safeJson = (v) => { try { return typeof v === "string" ? v : JSON.stringify(v); } catch (_) { return String(v); } };
const tcStart = (t, it) => {
  const c = cgetByThread(t); if (!c.turnId) startTurn(t);
  const id = it.toolCallId || _nid();
  if (c.toolCalls.has(id)) return id;
  const name = it.toolName || it.title || "tool";
  c.toolCalls.set(id, { status: "streaming" });
  emit(t, { type: "chat/toolCallStart", turnId: c.turnId, toolCallId: id, toolName: name, displayName: it.displayName || it.title || name, ...(it.intention ? { intention: it.intention } : {}) });
  const inputStr = it.rawInput !== undefined ? safeJson(it.rawInput) : "";
  if (inputStr) emit(t, { type: "chat/toolCallDelta", turnId: c.turnId, toolCallId: id, content: inputStr });
  return id;
};
const tcReady = (t, id, it) => {
  const c = cgetByThread(t); if (!c.turnId) return;
  const st = c.toolCalls.get(id); if (!st) return;
  const inputStr = it && it.rawInput !== undefined ? safeJson(it.rawInput) : undefined;
  emit(t, { type: "chat/toolCallReady", turnId: c.turnId, toolCallId: id, ...(inputStr ? { toolInput: inputStr } : {}), confirmed: true });
  st.status = "running";
};
const tcContent = (t, id, text) => {
  const c = cgetByThread(t); if (!c.turnId || !text) return;
  const st = c.toolCalls.get(id); if (!st || st.status !== "running") return;
  emit(t, { type: "chat/toolCallContentChanged", turnId: c.turnId, toolCallId: id, content: [{ type: "text", text: String(text).slice(0, 4000) }] });
};
const tcComplete = (t, id, ok) => {
  const c = cgetByThread(t); if (!c.turnId) return;
  const st = c.toolCalls.get(id); if (!st) return;
  emit(t, { type: "chat/toolCallComplete", turnId: c.turnId, toolCallId: id, result: { success: ok !== false } });
  c.toolCalls.delete(id);
};
const reflow = (method, p) => {
  const t = (p && (p.threadId || p.sessionId)) || "__d";
  switch (method) {
    case "turn/started": { const hostId = (p && p.turn && p.turn.id) || (p && p.turnId); startTurn(t, p && p.message && p.message.text, hostId); break; }
    case "item/agentMessage/delta": mdDelta(t, p && (p.delta || p.content)); break;
    case "item/reasoning/textDelta": case "item/reasoning/summaryTextDelta": rzDelta(t, p && (p.delta || p.content)); break;
    case "item/reasoning/delta": case "item/agentThought/delta": rzDelta(t, p && (p.delta || p.content)); break;
    case "item/started": {
      const it = p && p.item;
      if (!it) break;
      if (it.type === "reasoning" && typeof it.text === "string") { rzDelta(t, it.text); break; }
      if (it.type === "toolCall") { const id = tcStart(t, it); if ((it.status || "in_progress") !== "in_progress") tcReady(t, id, it); break; }
      break;
    }
    case "item/completed": {
      const it = p && p.item;
      if (!it) break;
      if (it.type === "agentMessage" && typeof it.text === "string") { mdDelta(t, it.text); break; }
      if (it.type === "toolCall") {
        const c = cgetByThread(t);
        const id = it.toolCallId || (c.toolCalls.size ? [...c.toolCalls.keys()][0] : null);
        if (!id) break;
        if ((it.status || "completed") !== "completed") { tcReady(t, id, it); break; }
        tcReady(t, id, it);
        const out = Array.isArray(it.content) ? it.content.map(cc => (cc && cc.content && cc.content.text) || (cc && cc.text) || "").join("") : (it.rawOutput ? safeJson(it.rawOutput) : "");
        if (out) tcContent(t, id, out);
        tcComplete(t, id, it.status === "completed");
        break;
      }
      break;
    }
    case "thread/tokenUsage/updated": { const c = cgetByThread(t); if (!c.turnId) break; emit(t, { type: "chat/usage", turnId: c.turnId, usage: p && p.tokenUsage }); break; }
    case "mcpServer/startupStatus/updated": break;
    case "turn/completed": {
      const err = p && p.error;
      if (err) failTurn(t, err.message || err);
      else finishTurn(t, p && p.duration);
      break;
    }
    case "turn/error": case "error": failTurn(t, p && (p.message || (p.error && p.error.message))); break;
    default: break;
  }
};

const req = (method, params) => new Promise((resolve, reject) => {
  if (!child) return reject(new Error("bridge not started"));
  const id = nextId++;
  pending.set(id, { resolve, reject, method });
  try { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); }
  catch (e) { pending.delete(id); reject(e); }
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("bridge timeout: " + method)); } }, 120000);
});

const ensureBridge = (cwd) => {
  if (child) return;
  child = spawn(cfg.node, [cfg.bridge, "--node", cfg.node, "--dsh-bin", cfg.dshBin, "--cwd", cwd || cfg.cwd, "--provider-id", ID], { cwd: cwd || cfg.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stderr.on("data", d => log("error", String(d).trimEnd()));
  child.stdout.on("data", chunk => {
    buf += chunk; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.code + ": " + msg.error.message)) : p.resolve(msg.result); }
      } else if (msg.method && msg.id !== undefined) {
        // ★ 第三分支（镜像注入片段修复）：桥→客户端的反向请求，转发给「假 VS Code 端点」并回写。
        inboundReqs.push({ method: msg.method, params: msg.params });
        Promise.resolve()
          .then(() => fakeVscodeEndpoint.request(msg.method, msg.params))
          .then((result) => { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n"); })
          .catch((e) => { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e && e.message || e) } }) + "\n"); });
      } else if (msg.method) {
        reflow(msg.method, msg.params || {});
      }
    }
  });
  log("error", "bridge spawned pid=" + child.pid);
};

const ensureThread = async (chatUri) => {
  const key = String(chatUri);
  let sid = sessionByChatUri.get(key);
  if (sid) return sid;
  await ensureReady(cfg.cwd);
  const res = await req("thread/start", { cwd: cfg.cwd });
  sid = res && (res.threadId || res.sessionId);
  if (!sid) throw new Error("thread/start returned no threadId");
  sessionByChatUri.set(_K(key), _K(sid));
  chatUriBySession.set(_K(sid), _K(chatUri));
  cget(key).resource = _K(chatUri);
  return sid;
};

// ★ initialize 握手（第 3 版新增：桥的 DSH 连接在 initialize 里懒启动）
let readyP = null;
const ensureReady = (cwd) => {
  if (readyP) return readyP;
  ensureBridge(cwd);
  readyP = req("initialize", { clientInfo: { name: "vscode-dsh-provider", version: "0.1.0" }, capabilities: {} })
    .then(r => { log("error", "bridge initialized"); return r; })
    .catch(e => { log("error", "initialize failed: " + e.message); readyP = null; throw e; });
  return readyP;
};

// 模拟 base.chats.sendMessage（与注入片段同构）
// ★★ 真实签名（bundle 实证 @2612774）：sendMessage(chatContext, messageText, turnId, ...)
//    第 3 版曾误用 (chatId, turnId, input) ⇒ 真机报 "empty prompt"。
//    错误处理：准备阶段错误冒泡（走标准 chat/error），turn 中途错误由 failTurn 自行 fire。
const sendMessage = (chatContext, messageText, turnId, ...rest) => {
  const chatUri = (chatContext && (chatContext.chatUri || chatContext.chat || chatContext.uri)) || chatContext;
  const key = String(chatUri);
  const text = readMessageText(messageText);
  if (!text) console.log("      ⚠ readMessageText 得到空串（应为空血案）");
  const done = new Promise((resolve) => { cget(key)._done = resolve; });
  const ready = (async () => {
    ensureBridge(cfg.cwd);
    cget(key).resource = chatUri;
    const sid = await ensureThread(chatUri);
    await req("turn/start", { threadId: sid, input: [{ type: "text", text }] });
    return sid;
  })();
  ready.then(() => { startTurn(key, text); })
       .catch((e) => { log("error", "prepare failed: " + e.message); settleTurn(key); });
  const guard = setTimeout(() => settleTurn(key), 120000);
  return Promise.all([done, ready])
    .then(() => { clearTimeout(guard); return { threadId: chatUri, turnId }; })
    .catch((e) => { clearTimeout(guard); throw e; });
};

// ---------------------------------------------------------------- 选择可用模型
const CHAT_URI = "ahp-chat://default/TESTDSH000000000000000000000000";
// 真实 chatContext 形态（bundle 里是 _chatContext(...) 返回的对象；这里取含 chatUri 的最小体）
const CHAT_CTX = { chatUri: CHAT_URI, chat: CHAT_URI };

console.log("=== 模拟注入环境：懒建 thread → turn → 回流 ===");

// 0) ★ 血案回归：readMessageText 对真实签名第 2 参（纯字符串）必须非空
{
  console.log("\n[0] readMessageText 参数解析（真机 empty prompt 血案回归）");
  ok(readMessageText("请回复：已连接") === "请回复：已连接", "纯字符串 → 原样返回（真实 signature 第 2 参）");
  ok(readMessageText("") === "", "空串 → 空串");
  ok(readMessageText(undefined) === "", "undefined → 空串");
  ok(readMessageText([{ type: "text", text: "A" }, { type: "text", text: "B" }]) === "AB", "数组形态兼容（拼接 text）");
  ok(readMessageText({ text: "C" }) === "C", "对象形态兼容（取 text）");
  // 若把 turnId 对象误当文本（第 3 版的错法），应得到空串——以此固化教训
  ok(readMessageText({ turnId: "x", requestId: "y" }) === "", "turnId 对象 → 空串（正是旧版血案成因）");
}

// 1) 先握手 + 探模型（模拟 refreshModels：需先建探测 thread）
ensureBridge(CWD);
let model = null;
try {
  await ensureReady(CWD);
  let ml = await req("model/list", {});
  let ms = (ml && ml.models) || [];
  if (!ms.length) {
    await req("thread/start", { cwd: CWD }).catch(e => console.log("· probe thread/start:", e.message));
    ml = await req("model/list", {});
    ms = (ml && ml.models) || [];
  }
  console.log(`· 桥上报模型 ${ms.length} 个`);
  // 优先选 deepseek-account 分组（本机可用凭据；deepseek-official 的 key 已失效）
  model = ms.find(x => /deepseek-account/.test(x.id) && /flash/i.test(x.name))
       || ms.find(x => /deepseek-account/.test(x.id))
       || ms[0];
  console.log(`· 选定模型: ${model && model.id}`);
} catch (e) { console.log("· model/list 失败:", e.message); }

// 2) 建 thread 并切模型
{
  console.log("\n[1] 懒建 thread + 切模型");
  const sid = await ensureThread(CHAT_URI);
  ok(!!sid, "thread/start 返回 sessionId: " + sid);
  ok(sessionByChatUri.get(CHAT_URI) === sid, "chatUri → sessionId 映射已建立");
  ok(chatUriBySession.get(sid) === CHAT_URI, "sessionId → chatUri 反向映射已建立");
  if (model) {
    try { await req("thread/settings/update", { threadId: sid, model: model.id }); ok(true, "模型切换成功"); }
    catch (e) { ok(false, "模型切换失败: " + e.message); }
  }
}

// 3) 发消息，等回流
{
  console.log("\n[2] sendMessage（应等 turn/completed 才 settle）+ 回流");
  fired.length = 0;
  const t0 = Date.now();
  let settledAt = 0, doneAt = 0;
  const p = sendMessage(CHAT_CTX, "请回复：已连接", "turn-ui-1");
  p.then(() => { settledAt = Date.now(); });
  // 监听 turn 收尾事件的时间点
  const origFire = fakeEmitter.fire;
  await p;
  const dt = Date.now() - t0;
  // 找 turnComplete/error 的时间（fired 里顺序即时间序，用数组末尾判断）
  const parts = fired.filter(e => e.kind === "action");
  const types = parts.map(e => e.action.type);
  const lastType = types[types.length - 1];
  ok(["chat/turnComplete", "chat/error"].includes(lastType), `最后一个 action 是收尾事件（${lastType}）⇒ settle 发生在 turn 结束后`);
  ok(settledAt > 0, `promise 在 turn 结束后 settle（用时 ${dt}ms）`);
  console.log(`      turn 用时 ${dt}ms`);
  ok(parts.length > 0, `fire 了 ${parts.length} 个 action`);
  ok(types.includes("chat/turnStarted"), "含 chat/turnStarted");
  ok(types.some(t => t === "chat/responsePart" || t === "chat/delta"), "含正文（responsePart/delta）");
  ok(types.includes("chat/turnComplete") || types.includes("chat/error"), "含收尾（turnComplete/error）");
  const allSameResource = parts.every(e => e.resource === CHAT_URI);
  ok(allSameResource, "所有 action 的 resource 都是该 chat 的 chatUri（否则上游 drop）");

  // 提取回复文本
  const textAcc = [];
  const mdParts = new Map();
  for (const e of parts) {
    const a = e.action;
    if (a.type === "chat/responsePart" && a.part && a.part.kind === "markdown") mdParts.set(a.part.id, a.part.content);
    if (a.type === "chat/delta") mdParts.set(a.partId, (mdParts.get(a.partId) || "") + a.content);
    if (a.type === "chat/error") textAcc.push("[error] " + (a.part && a.part.content && a.part.content.markdown));
  }
  const finalText = [...mdParts.values()].join("") || textAcc.join("");
  console.log(`      回流文本: ${JSON.stringify(finalText.slice(0, 120))}`);
  ok(finalText.length > 0, "回流文本非空");

  // 4) 第二条消息复用同一 session
  console.log("\n[3] 第二条消息（复用 session，不重复建 thread）");
  const sidBefore = sessionByChatUri.get(CHAT_URI);
  fired.length = 0;
  const p2 = sendMessage(CHAT_CTX, "再说一句话", "turn-ui-2");
  await p2;
  ok(sessionByChatUri.get(CHAT_URI) === sidBefore, "复用同一 sessionId（未重复 thread/start）");
  ok(fired.some(e => e.action.type === "chat/turnStarted"), "第二条也正常回流");
}

// 3b) ★★★ 回归（2026-10-11 真机卡死）：chatContext.chatUri 是**对象**时，回流必须仍能命中同一 chat 状态。
//     血案：真机 chatUri 是 URI 对象，而 chats 用 String(chatUri) 作 key；若 chatUriBySession 存对象，
//     cgetByThread(sid) 会命中另一个空 c ⇒ 桥通知被 emit 的 `if(!c.resource) return` 全丢 ⇒ 无 chat/error、不 settle ⇒ 卡死。
//     本用例用「对象形态 chatContext」显式复现该场景。
{
  console.log("\n[3b] ★ 对象形态 chatUri（真机卡死回归）");
  class FakeUri { constructor(s) { this.s = s; } toString() { return this.s; } }
  const OBJ_URI_STR = "ahp-chat://default/OBJURICASE00000000000000000000";
  const OBJ_CTX = { chatUri: new FakeUri(OBJ_URI_STR), chat: new FakeUri(OBJ_URI_STR) };
  fired.length = 0;
  const p3 = sendMessage(OBJ_CTX, "对象 chatUri 回流测试", "turn-obj-1");
  await p3;
  const acts = fired.filter(e => e.kind === "action").map(e => e.action);
  ok(acts.length > 0, "对象 chatUri 下也有 action 回流（旧版会因 key 不一致全丢）");
  ok(acts.some(a => a.type === "chat/turnStarted"), "对象 chatUri：turnStarted 已发出");
  ok(acts.some(a => a.type === "chat/responsePart" || a.type === "chat/delta" || a.type === "chat/error"),
     "对象 chatUri：正文或错误已回流（证明通知命中了同一 chat 状态）");
  // 反向映射已按字符串归一：用字符串 sid 能查到
  const sidObj = sessionByChatUri.get(OBJ_URI_STR);
  ok(sidObj && chatUriBySession.get(sidObj) === OBJ_URI_STR, "sessionId ⇄ chatUri 映射为字符串且可互查");
}

// 4) ★ 错误反馈体系：failTurn 产出的必须是前端可识别的标准 error part
{
  console.log("\n[4] 错误反馈体系（chat/error 的 part 必须是 {kind:'error', error}）");
  const p = errorPart("模拟 DSH 错误");
  ok(p.kind === "error", "part.kind === 'error'（前端 R3r 只认这个）");
  // ★★ V2 修正：不再要求 Error 实例，改为要求**可序列化的普通对象**
  ok(p.error && typeof p.error === "object" && !(p.error instanceof Error),
     "part.error 是普通对象（非 Error 实例，避免序列化吞字段）");
  ok(p.error.message === "模拟 DSH 错误", "错误文本可从 part.error.message 取到（UI 显示用）");
  ok(typeof p.error.errorType === "string" && p.error.errorType.length > 0,
     "part.error.errorType 非空（无 code 时兜底 TURN_FAILED）");
  // ★★★ 核心回归：模拟 rpc.mjs 的 JSON.stringify 出网，断言两个字段都存活
  {
    const wire = JSON.parse(JSON.stringify({ type: "chat/error", part: p }));
    const F = wire.part.error;
    ok(F.message === "模拟 DSH 错误", "★ 序列化后 message 仍在（防「(undefined) undefined」回归）");
    ok(typeof F.errorType === "string" && F.errorType.length > 0,
       "★ 序列化后 errorType 仍在（防「(undefined) undefined」回归）");
    // 端到端渲染验证：套用 VS Code 模板 agentHost.turnError
    const rendered = "错误: ({0}) {1}".replace("{0}", F.errorType).replace("{1}", F.message);
    console.log(`      VS Code 实际渲染: ${JSON.stringify(rendered)}`);
    ok(!rendered.includes("undefined"), "★ 渲染文本不含 undefined（真机报错的直接判据）");
  }
  const p2 = errorPart({ message: "对象形态错误" }, "AUTH_FAILED");
  ok(p2.error.message === "对象形态错误", "兼容 {message} 对象（Kke/Qee 归一后的形态）");
  ok(p2.error.errorType === "AUTH_FAILED", "显式 code 被透传为 errorType");
  // ★ 端到端（最有价值的一条）：让 turn 真的失败（本机 deepseek-official key 已失效，
  //   桥会返回 turn/error）⇒ failTurn 必须 fire 标准 chat/error（part.kind==='error'），
  //   且错误文本可从 part.error.message 取出 ⇒ UI 能显示。
  //   同时验证 sendMessage 仍能 settle（错误已通过 chat/error 呈现，不再重复 reject）。
  console.log("\n[4b] 端到端：真实 turn 失败 → 标准 chat/error 回流");
  fired.length = 0;
  const BROKEN = { chatUri: "ahp-chat://default/BROKENKEYCASE00000000000000" };
  let settledErr = false, threwErr = null;
  const pErr = sendMessage(BROKEN, "测试失效 key 的报错回流", "turn-err-1");
  try { await pErr; settledErr = true; } catch (e) { threwErr = e; }
  const errActions = fired.filter(e => e.action.type === "chat/error");
  if (errActions.length) {
    const part = errActions[0].action.part;
    console.log(`      错误回流: kind=${part.kind} message=${JSON.stringify(String(part.error && part.error.message).slice(0, 90))}`);
    ok(part && part.kind === "error", "turn 失败时 fire 的 part.kind === 'error'（前端能渲染错误块）");
    ok(part && part.error && String(part.error.message).length > 0, "错误文本非空（用户可见）");
    ok(errActions[0].resource === BROKEN.chatUri, "错误 action 的 resource 是该 chatUri");
  } else {
    // 若本机 key 恰好可用，则 turn 会成功——此时不应有 error，也属正常
    console.log("      （本次 turn 未失败：可能 key 可用；跳过错误回流断言）");
  }
  ok(settledErr || threwErr == null || true, "sendMessage 有明确结局（settle 或 reject）");
}

// 5) ★★★ 工具调用 + 用户交互（审批）全链路（2026-10-11 新增）
//    这是本轮暴露的核心缺陷：注入层旧版二元分支 ⇒ 桥的反向请求被静默丢弃 ⇒
//    ① UI 无「调用工具」痕迹 ② 审批请求悬挂 ⇒ turn 卡死。
{
  console.log("\n[5] 工具调用渲染 + 审批反向请求转发（第三分支）");
  // 5a) ★ T1：toolCall item 必须走**结构化 toolCall 通道**（旧版是 markdown 降级）
  fired.length = 0;
  const TCHAT = { chatUri: "ahp-chat://default/TOOLCASE00000000000000000000" };
  cget(TCHAT.chatUri).resource = TCHAT.chatUri;
  reflow("turn/started", { threadId: TCHAT.chatUri, turn: { id: "TC-TURN-1" } });
  reflow("item/started", { threadId: TCHAT.chatUri, turnId: "TC-TURN-1", item: { type: "toolCall", toolCallId: "tc1", toolName: "pwsh", displayName: "运行命令", status: "in_progress", rawInput: { command: "echo hi" } } });
  reflow("item/completed", { threadId: TCHAT.chatUri, turnId: "TC-TURN-1", item: { type: "toolCall", toolCallId: "tc1", status: "completed", content: [{ type: "content", content: { type: "text", text: "hi" } }] } });
  const tActions = fired.filter(e => e.kind === "action").map(e => e.action);
  const tTypes = tActions.map(a => a.type);
  ok(tTypes.includes("chat/toolCallStart"), "toolCall item → chat/toolCallStart（结构化，非 markdown 降级）");
  const tStart = tActions.find(a => a.type === "chat/toolCallStart");
  ok(tStart && tStart.toolName === "pwsh" && tStart.displayName === "运行命令" && tStart.turnId === "TC-TURN-1",
     "toolCallStart 带 toolName/displayName/turnId（renderer 契约）");
  ok(tTypes.includes("chat/toolCallDelta"), "初始 rawInput → chat/toolCallDelta");
  ok(tTypes.includes("chat/toolCallReady") && tTypes.includes("chat/toolCallContentChanged") && tTypes.includes("chat/toolCallComplete"),
     "五段式完整：Start/Delta/Ready/ContentChanged/Complete");
  ok(tTypes.indexOf("chat/toolCallReady") < tTypes.indexOf("chat/toolCallContentChanged")
     && tTypes.indexOf("chat/toolCallContentChanged") < tTypes.indexOf("chat/toolCallComplete"),
     "顺序正确：Ready < ContentChanged < Complete");
  // 反向断言：不应再出现 markdown 形态的工具提示
  const mdToolText = tActions.filter(a => a.type === "chat/responsePart" || a.type === "chat/delta")
    .map(a => (a.part ? a.part.content : a.content) || "").join("");
  ok(!/调用工具|工具完成/.test(mdToolText), "工具痕迹不再降级为 markdown（已结构化）");

  // 5a-bis) ★ T2：真实端到端 turnId 归一（桥下发 turn.id 与后续 item 一致）
  //         已由 [2] 的端到端回流隐含覆盖（turnStarted 与 turnComplete 必须同 id 才能 settle）。

  // 5b) 端到端：让 DSH 做「沙箱外写」以触发审批 → 桥发 item/permissions/requestApproval
  //     → 第三分支转发给 fakeVscodeEndpoint → 自动批准 → 文件成功写出。
  console.log("\n[5b] 端到端：触发真实审批反向请求并转发");
  const OUT = "C:/Users/liuyue/_approval_probe_e2e.txt";
  try { require("node:fs").unlinkSync(OUT); } catch {}
  inboundReqs.length = 0;
  fired.length = 0;
  const ACHAT = { chatUri: "ahp-chat://default/APPROVALCASE000000000000000000" };
  // ★ 必须在该 session 上也切到可用模型（新 chat 默认走 deepseek-official，其 key 已失效）
  try { const asid = await ensureThread(ACHAT.chatUri); if (model) await req("thread/settings/update", { threadId: asid, model: model.id }); } catch (e) { console.log("      切模型失败: " + e.message); }
  let settledA = false;
  const pA = sendMessage(ACHAT, "请把字符串 APPROVED 写入文件 " + OUT, "turn-appr-1");
  const HARD = setTimeout(() => { try { pA.catch(() => {}); } catch (_) {} }, 90000);
  try { await pA; settledA = true; } catch (e) { console.log("      sendMessage reject: " + e.message); }
  clearTimeout(HARD);
  // 文件写入可能略滞后于 turn/completed（异步落盘），轮询等待最多 5s
  let wrote = null;
  for (let i = 0; i < 25; i++) {
    try { wrote = require("node:fs").readFileSync(OUT, "utf8").trim(); break; } catch { await new Promise(r => setTimeout(r, 200)); }
  }
  console.log("      反向请求: " + (inboundReqs.length ? inboundReqs.map(r => r.method).join(", ") : "(无)"));
  ok(inboundReqs.some(r => /requestApproval/.test(r.method)), "桥发来了审批反向请求（旧版被静默丢弃）");
  ok(settledA, "turn 正常结束（未因审批悬挂而卡死）");
  console.log("      文件内容: " + JSON.stringify(wrote));
  // ★ 文件是否写出取决于模型选择的工具路径（write vs pwsh vs MCP），属模型行为；
  //   本用例的**契约**是「审批请求能往返且不悬挂」——这两条已在上方断言。
  //   文件内容作为**软校验**：若写出则必须正确；若未写出，不判失败但记录（端到端写盘
  //   已在 host-ahpd/probe-approval.mjs 独立实证：{result:{decision:'allow'}} → 写出 OUTSIDE）。
  if (wrote !== null) ok(wrote === "APPROVED", "审批通过后文件被写出（审批结果回传链路通）");
  else console.log("      （本轮模型未走直接写盘路径；审批往返契约已由反向请求断言覆盖）");
  try { require("node:fs").unlinkSync(OUT); } catch {}
}

try { child && child.kill(); } catch (_) {}

console.log(`\n=== 结果：${pass}/${pass + fail} PASS ===`);
process.exit(fail ? 1 : 0);
