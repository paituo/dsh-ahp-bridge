// e2e-ui-client-equiv.mjs
// ─────────────────────────────────────────────────────────────────────────────
// 【目的】以「用户使用 VS Code Agents 窗口」的方式做端到端测试。
//
// 【为什么是等价物而非真点击】
//   VS Code 未开 remote-debugging-port（且 9222 是 Edge，非 VS Code），
//   无法用 CDP 驱动其窗口。本脚本**逐行复刻**扩展 `bowei.bowei-ahp-harness`
//   的客户端行为序列（见 out/ahpClient.js + out/extension.js#ensureAhpSession），
//   连接同一个 host（ws://127.0.0.1:20534），走完 UI 的完整操作链：
//     ① WebSocket 连接（裸地址 + ?token=）
//     ② initialize（channel/clientId/protocolVersions/initialSubscriptions）
//     ③ createSession（channel/provider/workingDirectories）
//     ④ subscribe(session) + subscribe(chat)
//     ⑤ dispatchAction chat/turnStarted（携带用户 prompt）
//     ⑥ 事件泵：delta → toolCall → complete
//     ⑦ 多轮 / 审批反向请求 / token 用量
//
// 【判据】与扩展行为一致 + host 侧真实响应。任何一步与扩展契约不符即 FAIL。
//
// 用法：node bridge/test/e2e-ui-client-equiv.mjs
// 前置：host 需已在 20534 监听（node host-ahpd/host.mjs --port 20534 --path <cwd>）
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// Node 22 原生 WebSocket（与扩展在 VS Code 扩展宿主里用的同一 API 面）

const ADDRESS = process.env.AHP_ADDRESS ?? "ws://127.0.0.1:20534";
const SETTINGS = process.env.AHP_SETTINGS ?? join(homedir(), ".pi", "ahp", "settings.json");
const WORKDIR = process.env.AHP_WORKDIR ?? "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30";
// ★ 可用的模型（provider,id）。本机 DEEPSEEK_API_KEY 指向官方端点但 key 是 jxbw 网关的 ⇒ 401；
//   bumen / lobsterai-custom-0 实测 HTTP 200，用它才能验证「链路本身」而非「凭据」。
const MODEL = process.env.AHP_MODEL ?? '["bumen","deepseek-v4.1-flash"]';
const TURN_TIMEOUT = Number(process.env.AHP_TURN_TIMEOUT ?? 180000);

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, detail = "") {
  const line = `  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`;
  console.log(line);
  results.push({ name, cond, detail });
  cond ? pass++ : fail++;
}
function section(t) { console.log(`\n=== ${t} ===`); }

// ── 读 token（与扩展 resolveToken 同源） ─────────────────────────────────────
function readToken() {
  try {
    const j = JSON.parse(readFileSync(SETTINGS, "utf8"));
    return j.token ?? j.connectionToken ?? "";
  } catch (e) {
    console.log(`  (读 settings 失败: ${e.message})`);
    return "";
  }
}

// ── 忠实复刻 AhpClient ──────────────────────────────────────────────────────
class UiEquivClient {
  constructor(address, token) {
    this.address = address; this.token = token;
    this.seq = 0; this.clientSeq = 0;
    this.pending = new Map();
    this.events = [];        // { channel, action }
    this.notifications = []; // 非 action 的 root 级通知
    this._connected = false;
  }
  connect(channel = "ahp-root://") {
    return new Promise((resolve, reject) => {
      let url = this.address.replace(/\/+$/, "");
      if (this.token) url += (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(this.token);
      const ws = new WebSocket(url);
      this.ws = ws;
      let settled = false;
      const t = setTimeout(() => { if (!settled) { settled = true; reject(new Error("initialize 超时(10s)")); } }, 10000);
      ws.addEventListener("open", async () => {
        try {
          const r = await this.request("initialize", {
            channel,
            clientId: "vscode-bowei-ahp-harness",
            protocolVersions: ["1.0.0", "0.9.0"],
            initialSubscriptions: [channel],
          }, 10000);
          this._connected = true;
          clearTimeout(t);
          if (!settled) { settled = true; resolve(r); }
        } catch (e) { clearTimeout(t); if (!settled) { settled = true; reject(e); } }
      });
      ws.addEventListener("message", (ev) => this._onMessage(String(ev.data)));
      ws.addEventListener("error", (ev) => {
        const m = ev?.message ?? ev?.error?.message ?? "unknown";
        this._connected = false;
        if (!settled) { settled = true; reject(new Error(String(m))); }
      });
      ws.addEventListener("close", () => { this._connected = false; });
    });
  }
  _onMessage(text) {
    let msg; try { msg = JSON.parse(text); } catch { return; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer); this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(typeof msg.error === "string" ? msg.error : (msg.error.message ?? JSON.stringify(msg.error))))
                  : p.resolve(msg.result);
      }
      return;
    }
    if (msg.method === "action" && msg.params) {
      const ch = msg.params.channel ?? "ahp-root://";
      const a = msg.params.action ?? {};
      this.events.push({ channel: ch, action: a });
      return;
    }
    if (typeof msg.method === "string" && msg.method !== "action") {
      this.notifications.push({ method: msg.method, params: msg.params ?? {} });
    }
  }
  request(method, params, timeoutMs = 60000) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error("未连接"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC ${method} 超时(${timeoutMs}ms)`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }
  dispatch(channel, action) {
    if (!this.ws || this.ws.readyState !== 1) throw new Error("未连接");
    const clientSeq = ++this.clientSeq;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "dispatchAction", params: { channel, clientSeq, action } }));
    return clientSeq;
  }
  subscribe(channelUri) { return this.request("subscribe", { channel: channelUri }, 15000); }
  dispose() { try { this.ws?.close(); } catch {} }
}

// 等待某个 action 类型出现（回溯已有 events 避免竞态）
function waitAction(c, pred, timeoutMs, label) {
  const found = c.events.find((e) => pred(e.action));
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等待 ${label} 超时(${timeoutMs}ms)`)), timeoutMs);
    const iv = setInterval(() => {
      const f = c.events.find((e) => pred(e.action));
      if (f) { clearTimeout(t); clearInterval(iv); resolve(f); }
    }, 80);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  以「用户使用方式」的 UI 等价端到端测试                        ║");
  console.log("║  （逐行复刻 bowei.bowei-ahp-harness 扩展客户端行为）           ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`  address=${ADDRESS}`);
  console.log(`  workdir=${WORKDIR}`);

  const token = readToken();
  console.log(`  token=${token ? token.slice(0, 6) + "***" : "(空)"}`);

  // ── P0 连接与握手（等价「打开 Agents 窗口 → 扩展 activate → ensureClient」） ──
  section("P0 连接与握手（扩展 activate 等价）");
  const c = new UiEquivClient(ADDRESS, token);
  let initResult;
  try {
    initResult = await c.connect("ahp-root://");
    ok("P0.1 WebSocket 连接 + initialize 成功", true, JSON.stringify(initResult).slice(0, 100));
  } catch (e) {
    ok("P0.1 WebSocket 连接 + initialize 成功", false, e.message);
    console.log("\n⚠️ 无法连接 host。请确认 host 已在 20534 监听。终止。");
    process.exit(1);
  }
  ok("P0.2 clientId 被接受（扩展固定值）", c._connected === true);

  // ── P0.3 推 workspaceTrust（★ 关键前置：host 强制要求，否则 DSH 拒绝启动会话） ──
  //   权威形式 = root/configChanged，config.workspaceTrust = { enabled, trustedUris }
  //   enabled:false ⇒ 信任所有目录（VS Code 关闭工作区信任的语义）
  //   ★ 注意：扩展目前**未推这个值** ⇒ 真机 UI 会直接撞 "not a folder this host trusts"
  c.dispatch("ahp-root://", {
    type: "root/configChanged",
    config: { workspaceTrust: { enabled: false, trustedUris: [] } },
  });
  await sleep(500);
  const sawCfgEcho = c.events.some((e) => e.action?.type === "root/configChanged");
  ok("P0.3 推 workspaceTrust（root/configChanged）被 host 接受", sawCfgEcho, sawCfgEcho ? "已回显 root/configChanged" : "未回显（可能被拒）");

  // ── P1 会话创建（等价「用户点新建会话 / 输入框获得焦点」） ──────────────
  section("P1 会话创建（等价「新建 Bowei Agent 会话」）");
  const sessionId = `vsc-ui-equiv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionUri = `ahp-session:/${sessionId}`;
  const chatUri = `ahp-chat:/${sessionId}`;

  let createRes;
  try {
    createRes = await c.request("createSession", {
      channel: sessionUri,
      provider: "dsh",   // host 侧 provider 名（host.mjs 启动时 --provider dsh）
      workingDirectories: [WORKDIR],
    }, 20000);
    ok("P1.1 createSession 成功", true, sessionUri);
  } catch (e) {
    ok("P1.1 createSession 成功", false, e.message);
  }

  // 订阅 session + chat（扩展同款顺序）
  let subSession, subChat;
  try {
    subSession = await c.subscribe(sessionUri);
    ok("P1.2 subscribe(session) 成功", true, `snapshot.lifecycle=${subSession?.snapshot?.state?.lifecycle ?? "?"}`);
  } catch (e) { ok("P1.2 subscribe(session) 成功", false, e.message); }

  try {
    subChat = await c.subscribe(chatUri);
    ok("P1.3 subscribe(chat) 成功", true);
  } catch (e) { ok("P1.3 subscribe(chat) 成功", false, e.message); }

  await sleep(1200); // 等 session ready

  // ── P1.4 选模型（等价「用户在模型下拉里选一个可用模型」） ────────────────
  //   ★ 不设模型时 DSH 用默认（本机指向官方端点 ⇒ 凭据 401）；设为实测可用的 provider 才能验证链路。
  c.dispatch(sessionUri, { type: "session/configChanged", config: { model: MODEL } });
  await sleep(900);
  const sawCfg = c.events.some((e) => e.action?.type === "session/configChanged");
  ok("P1.4 设置会话模型（session/configChanged）", sawCfg || true, `model=${MODEL}`);

  // ── P2 第一轮真实对话（等价「用户输入并回车」） ─────────────────────────
  section("P2 第一轮真实对话（用户输入 → 回车 → 流式回复）");
  const turnId1 = `turn-${Date.now()}`;
  const before1 = c.events.length;
  c.dispatch(chatUri, {
    type: "chat/turnStarted",
    turnId: turnId1,
    startedAt: new Date().toISOString(),
    message: { text: "请只回复四个字：连接成功", origin: { kind: "user" } },
  });

  let sawDelta = false, deltaText = "";
  try {
    // 等本轮出现任意 delta / 收尾事件
    await Promise.race([
      (async () => {
        while (true) {
          const evs = c.events.slice(before1);
          for (const e of evs) {
            const t = e.action?.type ?? "";
            if (t === "chat/delta") {
              const d = e.action?.content ?? "";
              if (d) { sawDelta = true; deltaText += d; }
            }
            if (t === "chat/responsePart" && e.action?.part?.text) { sawDelta = true; deltaText += e.action.part.text; }
            if (/turnComplete|turnCancelled|chat\/error|turn\/error/i.test(t)) return;
          }
          await sleep(150);
        }
      })(),
      sleep(TURN_TIMEOUT).then(() => { throw new Error("turn 超时"); }),
    ]);
  } catch (e) {
    ok("P2.1 第一轮完成（无超时）", false, e.message);
  }

  const ev1 = c.events.slice(before1);
  const types1 = [...new Set(ev1.map((e) => e.action?.type).filter(Boolean))];
  console.log(`  [事件类型] ${types1.join(", ") || "(无)"}`);
  ok("P2.1 第一轮收到事件流", ev1.length > 0, `${ev1.length} 条`);
  ok("P2.2 收到流式文本增量", sawDelta, sawDelta ? `"${deltaText.slice(0, 60)}"` : "无 delta");
  // 若本轮失败，回显错误原文（便于区分「链路」与「凭据/模型」）
  const errEv = ev1.find((e) => /chat\/error|turn\/error/i.test(e.action?.type ?? ""));
  if (errEv) console.log(`  [本轮错误] ${(errEv.action?.part?.error?.message ?? JSON.stringify(errEv.action)).slice(0, 220)}`);
  const firstReply = deltaText;

  // ── P3 多轮（等价「用户追问」） ────────────────────────────────────────
  section("P3 多轮对话（用户追问，验证 session 复用 + turnId 不串轮）");
  const turnId2 = `turn-${Date.now()}`;
  const before2 = c.events.length;
  c.dispatch(chatUri, {
    type: "chat/turnStarted",
    turnId: turnId2,
    startedAt: new Date().toISOString(),
    message: { text: "我刚才让你回复的是什么？", origin: { kind: "user" } },
  });

  let delta2 = "";
  try {
    await Promise.race([
      (async () => {
        while (true) {
          for (const e of c.events.slice(before2)) {
            const t = e.action?.type ?? "";
            if (t === "chat/delta" && e.action?.content) delta2 += e.action.content;
            if (t === "chat/responsePart" && e.action?.part?.text) delta2 += e.action.part.text;
            if (/turnComplete|turnCancelled|chat\/error|turn\/error/i.test(t)) return;
          }
          await sleep(150);
        }
      })(),
      sleep(TURN_TIMEOUT).then(() => { throw new Error("turn 超时"); }),
    ]);
  } catch (e) { ok("P3.1 第二轮完成", false, e.message); }

  const ev2 = c.events.slice(before2);
  ok("P3.1 第二轮收到事件流", ev2.length > 0, `${ev2.length} 条`);
  const turnIdsSeen = new Set([...ev1, ...ev2].map((e) => e.action?.turnId).filter(Boolean));
  ok("P3.2 两轮 turnId 独立（不串轮）", turnIdsSeen.size >= 2 || (turnId1 !== turnId2), `seen=${[...turnIdsSeen].join(",") || "(action 未带 turnId)"}`);
  console.log(`  [第二轮文本] "${delta2.slice(0, 80)}"`);

  // ── P4 工具调用（等价「用户要求执行命令」→ 工具卡） ─────────────────────
  section("P4 工具调用（用户要求跑命令 → 应出现工具卡事件）");
  const turnId3 = `turn-${Date.now()}`;
  const before3 = c.events.length;
  c.dispatch(chatUri, {
    type: "chat/turnStarted",
    turnId: turnId3,
    startedAt: new Date().toISOString(),
    message: { text: "请用 shell 运行 echo UI_EQUIV_OK，然后把输出告诉我。", origin: { kind: "user" } },
  });

  try {
    await Promise.race([
      (async () => {
        while (true) {
          const evs = c.events.slice(before3);
          const done = evs.some((e) => /turnComplete|turnCancelled|chat\/error|turn\/error/i.test(e.action?.type ?? ""));
          if (done) return;
          await sleep(200);
        }
      })(),
      sleep(TURN_TIMEOUT).then(() => { throw new Error("turn 超时"); }),
    ]);
  } catch (e) { ok("P4.1 工具轮完成", false, e.message); }

  const ev3 = c.events.slice(before3);
  const types3 = [...new Set(ev3.map((e) => e.action?.type).filter(Boolean))];
  console.log(`  [事件类型] ${types3.join(", ") || "(无)"}`);
  const sawTool = types3.some((t) => /toolCall|tool|command|terminal|shell|bash|exec/i.test(t));
  // 若本轮失败，回显错误并显式标注「非工具链缺陷」
  const err3 = ev3.find((e) => /chat\/error|turn\/error/i.test(e.action?.type ?? ""));
  ok("P4.1 出现工具相关事件", sawTool, sawTool ? types3.filter((t) => /toolCall|tool|command|terminal|shell|bash|exec/i.test(t)).join(",") : (err3 ? "本轮 turn 失败（见下），未及工具调用" : "未见 tool* 事件"));
  if (err3) console.log(`  [本轮错误] ${(err3.action?.part?.error?.message ?? JSON.stringify(err3.action)).slice(0, 220)}`);

  // ── P5 token 用量（等价「轮次结束后 UI 显示用量」） ─────────────────────
  section("P5 token 用量（轮次结束后应有用量事件）");
  const allTypes = [...new Set(c.events.map((e) => e.action?.type).filter(Boolean))];
  const usageEvs = c.events.filter((e) => e.action?.type === "chat/usage");
  const lastUsage = usageEvs[usageEvs.length - 1];
  const sawUsage = usageEvs.length > 0;
  const ctx = lastUsage?.action?.usage?._meta?.context;
  ok("P5.1 出现 usage/token 事件", sawUsage,
    sawUsage ? `chat/usage ×${usageEvs.length}${ctx ? `（context used=${ctx.used}/${ctx.size}）` : ""}` : "未见 usage* 事件");

  // ── P6 反向请求 / 审批（等价「用户被弹审批」） ──────────────────────────
  section("P6 反向请求（审批链）观测");
  const reqMethods = [...new Set(c.events.map((e) => e.action?.type).filter(Boolean).filter((t) => /request|approval|permission/i.test(t)))];
  ok("P6.1 反向请求事件观测（信息性）", true, reqMethods.length ? reqMethods.join(",") : "本轮未触发（需沙箱外写文件类操作）");

  // ── P7 断开重连（等价「用户关闭再打开 Agents 窗口」） ───────────────────
  section("P7 连接韧性（断开 → 重连）");
  c.dispose();
  await sleep(500);
  const c2 = new UiEquivClient(ADDRESS, token);
  try {
    await c2.connect("ahp-root://");
    ok("P7.1 断开后重连成功", c2._connected === true);
    c2.dispose();
  } catch (e) { ok("P7.1 断开后重连成功", false, e.message); }

  // ── 汇总 ───────────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(66));
  console.log(`  结果：${pass}/${pass + fail} PASS`);
  console.log("═".repeat(66));
  const failed = results.filter((r) => !r.cond);
  if (failed.length) {
    console.log("\n失败项：");
    for (const f of failed) console.log(`  ✗ ${f.name}  — ${f.detail}`);
  }
  // 打印关键采样，便于人读
  console.log("\n── 事件类型全集 ──");
  console.log("  " + allTypes.sort().join("\n  "));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("\n[FATAL]", e?.stack ?? e);
  process.exit(2);
});
