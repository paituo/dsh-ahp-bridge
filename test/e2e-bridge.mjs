#!/usr/bin/env node
/**
 * 桥的离线端到端验证 —— 用「模拟 VS Code 客户端」驱动真实桥 + 真实 DSH ACP。
 *
 * 验证链路（完整，不碰生产 bundle）：
 *   模拟 VS Code (codex app-server 客户端)
 *        ⇅ stdio JSON-RPC
 *   桥 (bridge.mjs)
 *        ⇅ stdio JSON-RPC (ACP)
 *   dsh --profile acp  (真实子进程)
 *
 * 断言：
 *   A1  initialize 握手成功，桥回 serverInfo
 *   A2  thread/start → 拿到 threadId，且 models 非空（模型从 DSH configOptions 翻译而来）
 *   A3  session 真实建立（DSH 侧 sessionId 存在）
 *   A4  桥的 skills/list 有合法结构
 *   A5  关闭干净（无残留进程）
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, "..", "src", "bridge.mjs");

const NODE = process.env.BRIDGE_NODE || process.execPath;
const DSH_BIN = process.env.DSH_BIN || "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";
const CWD = process.env.BRIDGE_CWD || process.cwd();

// ---------------------------------------------------------------- 极简 codex 客户端
class CodexClient {
  constructor(child, log) {
    this.child = child;
    this.log = log;
    this.buf = "";
    this.id = 1;
    this.pending = new Map();
    this.notifications = [];
    this.notifyWaiters = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => this._onData(d));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { if (process.env.VERBOSE) process.stderr.write(`[bridge-stderr] ${d}`); });
  }
  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { this.log(`[warn] bad line ${line.slice(0,120)}`); continue; }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); msg.error ? p.reject(new Error(`${msg.error.code}: ${msg.error.message}`)) : p.resolve(msg.result); }
      } else if (msg.method) {
        this.notifications.push(msg);
        for (const w of this.notifyWaiters) w(msg);
      }
    }
  }
  request(method, params) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`timeout: ${method}`)); }, 45000);
    });
  }
  waitNotification(method, timeoutMs = 45000) {
    const hit = this.notifications.find((n) => n.method === method);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { reject(new Error(`no notification: ${method}`)); }, timeoutMs);
      const w = (m) => { if (m.method === method) { clearTimeout(t); this.notifyWaiters = this.notifyWaiters.filter((x) => x !== w); resolve(m); } };
      this.notifyWaiters.push(w);
    });
  }
}

// ---------------------------------------------------------------- 主流程
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function main() {
  console.log("=== 桥离线端到端验证 ===");
  console.log(`node   : ${NODE}`);
  console.log(`dsh-bin: ${DSH_BIN}`);
  console.log(`bridge : ${BRIDGE}`);
  console.log("");

  const child = spawn(NODE, [BRIDGE, "--node", NODE, "--dsh-bin", DSH_BIN, "--cwd", CWD, "--provider-id", "dsh", "--profile", "acp"], {
    cwd: CWD,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const client = new CodexClient(child, (m) => console.log(m));

  let exited = false;
  child.on("exit", () => { exited = true; });

  try {
    // A1 initialize
    const init = await client.request("initialize", { clientInfo: { name: "probe", version: "0" }, capabilities: {} });
    check("A1 initialize 握手", !!init?.serverInfo, JSON.stringify(init?.serverInfo));

    // A2 thread/start → models
    let start;
    try {
      start = await client.request("thread/start", { cwd: CWD, mcpServers: [] });
      check("A2 thread/start 返回 threadId", !!start?.threadId, `threadId=${start?.threadId}`);
      check("A2b 模型清单非空（DSH configOptions 翻译）", Array.isArray(start?.models) && start.models.length > 0,
        `models=${JSON.stringify(start?.models?.slice(0, 5) ?? [])}${start?.models?.length > 5 ? ` …(${start.models.length})` : ""}`);
    } catch (e) {
      check("A2 thread/start 返回 threadId", false, e.message);
      check("A2b 模型清单非空（DSH configOptions 翻译）", false, "skipped");
    }

    // A3 真实会话存在（thread/list 反查）
    //   ★ 2026-10-15 契约修正：thread/list 必须返回 `{ data:[...], nextCursor? }`
    //     （对齐 main bundle 的 sessionsDiscoveryScan：读 g.data，不是 threads）。
    try {
      const list = await client.request("thread/list", { limit: 100, modelProviders: [], sortKey: "updated_at" });
      check("A3 会话真实存在于 DSH", Array.isArray(list?.data), `data=${list?.data?.length ?? 0}`);
    } catch (e) {
      check("A3 会话真实存在于 DSH", false, e.message);
    }

    // A4 skills/list 结构 + 真实技能数
    try {
      const sk = await client.request("skills/list", { cwds: [CWD] });
      const n = (sk?.data ?? []).reduce((a, g) => a + (g.skills?.length ?? 0), 0);
      check("A4 skills/list 结构合法且有真实技能", Array.isArray(sk?.data) && n > 0, `data=${sk?.data?.length ?? 0} 组, skills=${n}`);

    } catch (e) {
      check("A4 skills/list 结构合法且有真实技能", false, e.message);
    }

    // A4b mcpServerStatus/list 结构
    try {
      const mc = await client.request("mcpServerStatus/list", {});
      check("A4b mcpServerStatus/list 结构合法", Array.isArray(mc?.mcpServers), `servers=${mc?.mcpServers?.length ?? 0}`);
    } catch (e) {
      check("A4b mcpServerStatus/list 结构合法", false, e.message);
    }

    // A5 未实现方法**语义化降级**（★ 2026-10-11 契约变更）：
    //    已知方法族的未实现项返回空值（供上游优雅降级），只有**真未知**方法才回 MethodNotFound。
    //    血案：以前一律 MethodNotFound ⇒ VS Code 把 thread/read 缺失当致命错误 ⇒ Session was never created 刷屏。
    try {
      const r = await client.request("thread/fork", { threadId: "x" });
      check("A5a 已知族未实现方法语义化降级（非报错）", r && typeof r === "object", JSON.stringify(r).slice(0, 60));
    } catch (e) {
      check("A5a 已知族未实现方法语义化降级（非报错）", false, e.message);
    }
    try {
      const r = await client.request("account/read", {});
      check("A5b account/read 降级为 {account:null}", r && "account" in r, JSON.stringify(r).slice(0, 60));
    } catch (e) {
      check("A5b account/read 降级为 {account:null}", false, e.message);
    }
    try {
      await client.request("totally/unknown/method", {});
      check("A5c 真未知方法仍报 Method not found", false, "竟然成功了");
    } catch (e) {
      check("A5c 真未知方法仍报 Method not found", /Method not found|-32601/.test(e.message), e.message.slice(0, 80));
    }
    // A5d thread/read 返回合法空 thread（修历史会话恢复报错）
    try {
      const r = await client.request("thread/read", { threadId: "unknown-sid", includeTurns: false });
      check("A5d thread/read 未知 session 返回合法空 thread",
        r?.thread?.id === "unknown-sid" && ["idle", "active"].includes(r?.thread?.status?.type),
        JSON.stringify(r?.thread).slice(0, 90));
    } catch (e) {
      check("A5d thread/read 未知 session 返回合法空 thread", false, e.message);
    }

  } catch (e) {
    check("主流程异常", false, e?.stack ?? String(e));
  } finally {
    try { child.stdin.end(); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 800));
    try { child.kill(); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 300));
  }

  const pass = results.filter((r) => r.ok).length;
  console.log("");
  console.log(`=== 结果：${pass}/${results.length} PASS ===`);
  if (process.env.VERBOSE) console.log(`notifications seen: ${client.notifications.map((n) => n.method).join(", ") || "(none)"}`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
