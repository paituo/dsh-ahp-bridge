// probe-ui-error.mjs — 单轮最小探针，抓 chat/error 原文 + 试推 workspaceTrust 对比
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ADDRESS = "ws://127.0.0.1:20534";
const SETTINGS = join(homedir(), ".pi", "ahp", "settings.json");
const WORKDIR = "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30";
const token = JSON.parse(readFileSync(SETTINGS, "utf8")).token;

const PUSH_TRUST = process.argv.includes("--trust");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class C {
  constructor() { this.seq = 0; this.clientSeq = 0; this.pending = new Map(); this.events = []; }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${ADDRESS}?token=${encodeURIComponent(token)}`);
      this.ws = ws;
      ws.addEventListener("open", async () => {
        try {
          await this.request("initialize", { channel: "ahp-root://", clientId: "vscode-bowei-ahp-harness", protocolVersions: ["1.0.0", "0.9.0"], initialSubscriptions: ["ahp-root://"] }, 10000);
          resolve();
        } catch (e) { reject(e); }
      });
      ws.addEventListener("message", (ev) => this._m(String(ev.data)));
      ws.addEventListener("error", (e) => reject(new Error(String(e.message ?? e))));
    });
  }
  _m(t) {
    let m; try { m = JSON.parse(t); } catch { return; }
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      const p = this.pending.get(m.id); if (p) { clearTimeout(p.timer); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } return;
    }
    if (m.method === "action") { this.events.push({ ch: m.params?.channel, a: m.params?.action }); return; }
    if (typeof m.method === "string") { this.events.push({ method: m.method, params: m.params }); }
  }
  request(method, params, ms = 60000) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error(`RPC ${method} timeout`)); }, ms);
      this.pending.set(id, { resolve: res, reject: rej, timer });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }
  dispatch(ch, action) { this.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "dispatchAction", params: { channel: ch, clientSeq: ++this.clientSeq, action } })); }
  subscribe(uri) { return this.request("subscribe", { channel: uri }, 15000); }
}

(async () => {
  console.log(`\n===== 探针: ${PUSH_TRUST ? "带 workspaceTrust" : "不带 workspaceTrust"} =====`);
  const c = new C();
  await c.connect();
  console.log("[ok] connected + initialized");

  if (PUSH_TRUST) {
    // ★ 权威形式：root/configChanged（不是 root/workspaceTrust）
    //   workspaceTrust 是 root config 的一个 key，readOnly（由客户端 push）
    //   enabled:false ⇒ 信任所有目录（VS Code 关闭工作区信任的语义）
    try {
      c.dispatch("ahp-root://", {
        type: "root/configChanged",
        config: { workspaceTrust: { enabled: false, trustedUris: [] } },
      });
      console.log("[ok] 已推 root/configChanged{workspaceTrust:{enabled:false}}");
      await sleep(400);
    } catch (e) { console.log("[warn] 推 trust 失败:", e.message); }
  }

  const sid = `probe-${Date.now()}`;
  const sUri = `ahp-session:/${sid}`, cUri = `ahp-chat:/${sid}`;
  const r = await c.request("createSession", { channel: sUri, provider: "dsh", workingDirectories: [WORKDIR] }, 20000);
  console.log("[ok] createSession:", JSON.stringify(r).slice(0, 200));

  const ss = await c.subscribe(sUri);
  console.log("[ok] subscribe(session) lifecycle=", ss?.snapshot?.state?.lifecycle);
  await c.subscribe(cUri);
  console.log("[ok] subscribe(chat)");
  await sleep(1500);

  const before = c.events.length;
  c.dispatch(cUri, {
    type: "chat/turnStarted", turnId: `turn-${Date.now()}`, startedAt: new Date().toISOString(),
    message: { text: "请只回复：OK", origin: { kind: "user" } },
  });
  console.log("[ok] 已发 chat/turnStarted，等 25s 收事件...");

  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    const evs = c.events.slice(before);
    if (evs.some((e) => /complete|idle|end|error|stopped/i.test(e.a?.type ?? ""))) break;
    await sleep(300);
  }

  console.log("\n── 本轮事件明细 ──");
  for (const e of c.events.slice(before)) {
    if (e.method) { console.log(`  [notify] ${e.method} ${JSON.stringify(e.params).slice(0, 160)}`); continue; }
    const t = e.a?.type ?? "?";
    const extra = JSON.stringify({ ...e.a, type: undefined }).slice(0, 260);
    console.log(`  ${t}  ${extra}`);
  }
  console.log("\n── 是否有文本/工具/用量 ──");
  const types = [...new Set(c.events.slice(before).map((e) => e.a?.type).filter(Boolean))];
  console.log("  types:", types.join(", ") || "(无)");
  process.exit(0);
})().catch((e) => { console.error("[FATAL]", e?.stack ?? e); process.exit(2); });
