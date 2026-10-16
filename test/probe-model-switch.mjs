// probe-model-switch.mjs — 验证：推 trust + 选可用模型（bumen）→ 完整对话链路
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ADDRESS = "ws://127.0.0.1:20534";
const SETTINGS = join(homedir(), ".pi", "ahp", "settings.json");
const WORKDIR = "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30";
const token = JSON.parse(readFileSync(SETTINGS, "utf8")).token;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class C {
  constructor() { this.seq = 0; this.clientSeq = 0; this.pending = new Map(); this.events = []; }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${ADDRESS}?token=${encodeURIComponent(token)}`);
      this.ws = ws;
      ws.addEventListener("open", async () => {
        try { await this.request("initialize", { channel: "ahp-root://", clientId: "vscode-bowei-ahp-harness", protocolVersions: ["1.0.0", "0.9.0"], initialSubscriptions: ["ahp-root://"] }, 10000); resolve(); }
        catch (e) { reject(e); }
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
  console.log("\n===== 探针：trust + 启用哪些模型/如何切 =====");
  const c = new C();
  await c.connect();
  c.dispatch("ahp-root://", { type: "root/configChanged", config: { workspaceTrust: { enabled: false, trustedUris: [] } } });
  await sleep(400);

  const sid = `ms-${Date.now()}`;
  const sUri = `ahp-session:/${sid}`, cUri = `ahp-chat:/${sid}`;
  await c.request("createSession", { channel: sUri, provider: "dsh", workingDirectories: [WORKDIR] }, 20000);
  const ss = await c.subscribe(sUri);
  await c.subscribe(cUri);

  // 打印 session snapshot 全文（含 models / config options）
  console.log("\n── session snapshot ──");
  console.log(JSON.stringify(ss, null, 2).slice(0, 2500));

  // 等 agentsChanged（模型列表）
  await sleep(2500);
  const agentsEv = c.events.filter((e) => e.a?.type === "root/agentsChanged").pop();
  if (agentsEv) {
    console.log("\n── root/agentsChanged 模型清单 ──");
    for (const ag of agentsEv.a.agents ?? []) {
      console.log(`  provider=${ag.provider} (${ag.displayName})`);
      for (const m of ag.models ?? []) console.log(`    id=${m.id}  name=${m.name}`);
    }
  } else {
    console.log("\n（未见 root/agentsChanged）");
  }

  // 看 session/configChanged 的 schema 期望什么
  console.log("\n── 尝试 session/configChanged 切模型 ──");
  try {
    c.dispatch(sUri, { type: "session/configChanged", config: { model: "[\"bumen\",\"deepseek-v4.1-flash\"]" } });
    await sleep(800);
    console.log("  已发 session/configChanged{model:[bumen,deepseek-v4.1-flash]}");
  } catch (e) { console.log("  失败:", e.message); }

  // 发一轮看结果
  const before = c.events.length;
  c.dispatch(cUri, { type: "chat/turnStarted", turnId: `turn-${Date.now()}`, startedAt: new Date().toISOString(), message: { text: "请只回复：OK", origin: { kind: "user" } } });
  console.log("  已发 turn，等 40s...");
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    if (c.events.slice(before).some((e) => /complete|idle|end|error|stopped/i.test(e.a?.type ?? ""))) break;
    await sleep(300);
  }
  console.log("\n── 本轮事件 ──");
  for (const e of c.events.slice(before)) {
    if (e.method) continue;
    const t = e.a?.type ?? "?";
    if (/error|delta|tool|usage|complete|message/i.test(t)) console.log(`  ${t}  ${JSON.stringify({ ...e.a, type: undefined }).slice(0, 300)}`);
  }
  const types = [...new Set(c.events.slice(before).map((e) => e.a?.type).filter(Boolean))];
  console.log("\n  本轮 types:", types.join(", "));
  process.exit(0);
})().catch((e) => { console.error("[FATAL]", e?.stack ?? e); process.exit(2); });
