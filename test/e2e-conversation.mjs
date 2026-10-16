#!/usr/bin/env node
/**
 * 桥的「真实对话」端到端验证 —— 验证完整串通：
 *   VS Code 客户端 → 桥 → DSH → (模型推理) → 事件流 → 桥翻译 → VS Code 客户端
 *
 * 断言：
 *   B1 turn/start 被接受，返回 turnId
 *   B2 收到 agentMessage 增量（item/agentMessage/delta）—— 证明 DSH 真的在回答
 *   B3 收到 turn/completed —— 证明轮次正常收尾
 *   B4 拼接出的文本非空 —— 证明内容真的流过来了
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, "..", "src", "bridge.mjs");
const NODE = process.env.BRIDGE_NODE || process.execPath;
const DSH_BIN = process.env.DSH_BIN || "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";
const CWD = process.env.BRIDGE_CWD || process.cwd();

class Client {
  constructor(child) {
    this.child = child; this.buf = ""; this.id = 1; this.pending = new Map();
    this.notifications = []; this.waiters = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => this._on(d));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { if (process.env.VERBOSE) process.stderr.write(`[bridge] ${d}`); });
  }
  _on(chunk) {
    this.buf += chunk; let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(`${m.error.code}: ${m.error.message}`)) : p.resolve(m.result); }
      } else if (m.method) {
        this.notifications.push(m);
        for (const w of [...this.waiters]) w(m);
      }
    }
  }
  request(method, params, timeoutMs = 180000) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`timeout: ${method}`)); }, timeoutMs);
    });
  }
  wait(method, timeoutMs = 180000) {
    const hit = this.notifications.find((n) => n.method === method);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { reject(new Error(`no notification: ${method}`)); }, timeoutMs);
      const w = (m) => { if (m.method === method) { clearTimeout(t); this.waiters = this.waiters.filter((x) => x !== w); resolve(m); } };
      this.waiters.push(w);
    });
  }
}

const results = [];
function check(name, ok, detail = "") { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); }

async function main() {
  console.log("=== 桥「真实对话」端到端验证 ===");
  const child = spawn(NODE, [BRIDGE, "--node", NODE, "--dsh-bin", DSH_BIN, "--cwd", CWD, "--provider-id", "dsh"], {
    cwd: CWD, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  const c = new Client(child);

  try {
    await c.request("initialize", { clientInfo: { name: "probe", version: "0" } });
    console.log("· initialize ok");

    const start = await c.request("thread/start", { cwd: CWD, mcpServers: [] });
    console.log(`· thread/start ok, threadId=${start.threadId}, models=${start.models?.length ?? 0}`);

    // 选模型：优先 account 分组（凭据可用），其次 flash
    const pick =
      start.models?.find((m) => m.provider === "deepseek-account" && /flash/i.test(m.name)) ??
      start.models?.find((m) => m.provider === "deepseek-account") ??
      start.models?.find((m) => /flash/i.test(m.name)) ??
      start.models?.[0];
    if (pick) {
      try {
        await c.request("thread/settings/update", { threadId: start.threadId, model: pick.id });
        console.log(`· 模型切到 ${pick.name}`);
      } catch (e) { console.log(`· 模型切换失败(不阻塞): ${e.message}`); }
    }

    // B1 发一轮
    let turn;
    try {
      turn = await c.request("turn/start", {
        threadId: start.threadId,
        input: [{ type: "text", text: "只回答两个字：收到" }],
      });
      check("B1 turn/start 被接受", !!turn?.turnId, `turnId=${turn?.turnId}`);
    } catch (e) {
      check("B1 turn/start 被接受", false, e.message);
    }

    // B2 收到 agentMessage 增量
    let sawDelta = false;
    const acc = [];
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("等待事件超时(90s)")), 90000);
        const w = (m) => {
          if (m.method === "item/agentMessage/delta") { sawDelta = true; acc.push(m.params?.delta ?? ""); }
          if (m.method === "turn/completed") { clearTimeout(t); c.waiters = c.waiters.filter((x) => x !== w); resolve(); }
        };
        c.waiters.push(w);
      });
      check("B2 收到 agentMessage 增量", sawDelta, `segs=${acc.length}`);
      check("B3 收到 turn/completed", true);
      const text = acc.join("").trim();
      check("B4 文本非空", text.length > 0, JSON.stringify(text.slice(0, 120)));
    } catch (e) {
      if (sawDelta) check("B2 收到 agentMessage 增量", true, `segs=${acc.length}`);
      else check("B2 收到 agentMessage 增量", false, e.message);
      check("B3 收到 turn/completed", c.notifications.some((n) => n.method === "turn/completed"), "");
      const text = acc.join("").trim();
      check("B4 文本非空", text.length > 0, JSON.stringify(text.slice(0, 120)));
    }

    if (process.env.VERBOSE) {
      const kinds = {};
      for (const n of c.notifications) kinds[n.method] = (kinds[n.method] ?? 0) + 1;
      console.log("· 通知统计:", JSON.stringify(kinds));
    }
  } catch (e) {
    check("主流程", false, e?.stack ?? String(e));
  } finally {
    try { child.stdin.end(); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 1000));
    try { child.kill(); } catch { /* ignore */ }
  }

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== 结果：${pass}/${results.length} PASS ===`);
  process.exit(pass === results.length ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
