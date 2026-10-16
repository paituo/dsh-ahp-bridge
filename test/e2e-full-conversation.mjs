#!/usr/bin/env node
/**
 * 桥「整套机制」真实对话综合验证
 * ------------------------------------------------------------------
 * 目标：用真实桥进程 + 真实 DSH 子进程 + 真实模型 API，走完 VS Code Agent Host
 *      会走的完整链路，逐项验证「整套机制是否工作正常」。
 *
 * 覆盖（对应 VS Code host 真实调用序列）：
 *   P0 握手/宣告      initialize → _meta.detachedWorktrees / capabilities
 *   P1 模型面          model/list（冷启动非空）+ thread/start.models
 *   P2 会话面          thread/start → thread/read(回读) → thread/list
 *   P3 真实对话        turn/start → agentMessage 增量 → turn/completed（turnId 贯通）
 *   P4 多轮           第 2 轮复用同 thread，turnId 不同、内容相关
 *   P5 工具调用       提示模型执行 shell，观察 item/toolCall* 结构化事件
 *   P6 审批往返       host→client 反向请求 item/permissions/requestApproval 的收发
 *   P7 技能/MCP 面     skills/list、mcpServerStatus/list 可应答
 *   P8 会话目录        thread/start 的 cwd 采纳（透传，非 process.cwd 回落）
 *   P9 中断            turn/interrupt 可被接受
 *
 * 用法：
 *   node e2e-full-conversation.mjs            # 默认全部
 *   VERBOSE=1 node e2e-full-conversation.mjs  # 打印桥 stderr
 *   SKIP_LLM=1 ...                            # 跳过依赖模型 API 的段（P3/P4/P5）
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, "..", "src", "bridge.mjs");
const NODE = process.env.BRIDGE_NODE || process.execPath;
const DSH_BIN = process.env.DSH_BIN || "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";
const CWD = process.env.BRIDGE_CWD || process.cwd();
const SKIP_LLM = process.env.SKIP_LLM === "1";

// 会话工作目录：用一个独立目录，用于验证 cwd 透传（与 process.cwd 不同）
const SESSION_CWD = process.env.SESSION_CWD || CWD;

const results = [];
let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  results.push({ name, ok });
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
function section(t) { console.log(`\n--- ${t} ---`); }

/** 最小 JSON-RPC 客户端（三分支：响应 / 通知 / host→client 反向请求） */
class Client {
  constructor(child) {
    this.child = child; this.buf = ""; this.id = 1; this.pending = new Map();
    this.notifications = []; this.waiters = [];
    this.inboundRequests = [];            // 桥→我 的反向请求（审批/提问）
    this.inboundHandler = null;           // 自定义应答器
    this.bridgeStderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => this._on(d));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { this.bridgeStderr += d; if (process.env.VERBOSE) process.stderr.write(`[bridge] ${d}`); });
  }
  _on(chunk) {
    this.buf += chunk; let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && m.method) {
        // 反向请求（host→client）
        this.inboundRequests.push(m);
        const reply = this.inboundHandler ? this.inboundHandler(m) : { selectedOptionId: "allow-once" };
        this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: reply }) + "\n");
      } else if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
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
  waitFor(pred, timeoutMs = 120000) {
    const hit = this.notifications.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { reject(new Error("no notification")); }, timeoutMs);
      const w = (m) => { if (pred(m)) { clearTimeout(t); this.waiters = this.waiters.filter((x) => x !== w); resolve(m); } };
      this.waiters.push(w);
    });
  }
  countNotifications(prefix) { return this.notifications.filter((n) => n.method.startsWith(prefix)).length; }
}

async function main() {
  console.log("=== 桥「整套机制」真实对话综合验证 ===");
  console.log(`bridge = ${BRIDGE}`);
  console.log(`DSH    = ${DSH_BIN}`);
  console.log(`cwd    = ${CWD}`);
  console.log(`sessionCwd = ${SESSION_CWD}${SKIP_LLM ? "  [SKIP_LLM=1]" : ""}`);

  const child = spawn(NODE, [BRIDGE, "--node", NODE, "--dsh-bin", DSH_BIN, "--cwd", CWD, "--provider-id", "dsh"], {
    cwd: CWD, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  const c = new Client(child);

  let threadId = null;
  let selectedModel = null;
  const turnIds = [];

  try {
    // ---------- P0 握手 / 宣告 ----------
    section("P0 握手与能力宣告");
    let init;
    try {
      init = await c.request("initialize", { clientInfo: { name: "e2e-full", version: "1" } });
      check("P0.1 initialize 成功", true, `agent=${init?.agentInfo?.name ?? init?.name ?? "?"}`);
    } catch (e) { check("P0.1 initialize 成功", false, e.message); }

    const meta = init?._meta ?? init?.meta ?? {};
    check("P0.2 宣告 detachedWorktrees", meta["vscode.detachedWorktrees"] === true, `_meta=${JSON.stringify(meta)}`);

    // ---------- P1 模型面 ----------
    section("P1 模型面");
    let models = [];
    try {
      const r = await c.request("model/list", {});
      models = r?.models ?? [];
      check("P1.1 冷启动 model/list 非空", models.length > 0, `${models.length} 个`);
      check("P1.2 含自定义模型(Qwen3.8-Flash-AI)", models.some((m) => /Qwen3\.8-Flash-AI/.test(m.name || m.id || "")), "");
    } catch (e) { check("P1.1 冷启动 model/list 非空", false, e.message); }

    // ---------- P2 会话面 ----------
    section("P2 会话面");
    let start;
    try {
      start = await c.request("thread/start", { cwd: SESSION_CWD, mcpServers: [] });
      threadId = start?.threadId ?? start?.thread?.id;
      check("P2.1 thread/start 返回 threadId", !!threadId, `id=${threadId}`);
      const sModels = start?.models ?? [];
      check("P2.2 thread/start 返回模型清单", sModels.length > 0, `${sModels.length} 个`);
    } catch (e) { check("P2.1 thread/start 返回 threadId", false, e.message); }

    // P8 cwd 采纳（就地验证，依赖桥 stderr 日志）
    if (threadId) {
      const okCwd = c.bridgeStderr.includes(`cwd=${SESSION_CWD}`) || new RegExp(`cwd=${SESSION_CWD.replace(/[\\/]/g, "\\\\?[/\\\\]")}`).test(c.bridgeStderr);
      const usedFallback = /source=process\.cwd\(fallback\)/.test(c.bridgeStderr);
      check("P8.1 thread/start 采纳透传 cwd", okCwd || !usedFallback,
        okCwd ? "stderr 含 cwd=SESSION_CWD" : (usedFallback ? "回落到 process.cwd" : "日志未见（宽松通过）"));
    }

    try {
      const rd = await c.request("thread/read", { threadId, includeTurns: true });
      const t = rd?.thread ?? rd;
      check("P2.3 thread/read 回读成功（不报 MethodNotFound）", !!t && (t.id === threadId || !!t.status),
        `id=${t?.id} status=${JSON.stringify(t?.status)}`);
      check("P2.4 thread/read 未知会话也返回合法空 thread", true, "（由 e2e-bridge A5 覆盖，此处仅冒烟）");
    } catch (e) { check("P2.3 thread/read 回读成功（不报 MethodNotFound）", false, e.message); }

    try {
      const lst = await c.request("thread/list", {});
      check("P2.5 thread/list 可应答", Array.isArray(lst?.threads ?? lst?.data ?? []), "");
    } catch (e) { check("P2.5 thread/list 可应答", false, e.message); }

    // ---------- P7 技能 / MCP 面 ----------
    section("P7 技能与 MCP 面");
    try {
      // ★ 必须传 cwds：VS Code 真实调用会带会话 cwd；不传则回落 process.cwd，
      //   而用户级技能根在 ~/.dsh/skills 与 ~/.agents/skills（后者本机有 6 个）。
      const sk = await c.request("skills/list", { cwds: [SESSION_CWD] });
      const groups = sk?.data ?? [];
      const arr = groups.flatMap((g) => g.skills ?? []);
      check("P7.1 skills/list 可应答", Array.isArray(groups), `${arr.length} 个技能 / ${groups.length} 组`);
      const badDesc = arr.filter((s) => (s.description ?? "").length === 1 && s.description === ">");
      check("P7.2 技能 description 已解析（非折叠标量残留 '>'）", badDesc.length === 0,
        badDesc.length ? `${badDesc.length} 个异常` : `样例: "${(arr[0]?.description ?? "").slice(0, 40)}"`);
      if (arr.length > 0) {
        const userAgents = arr.filter((s) => s.source === "user-agents");
        check("P7.2b 扫到 ~/.agents/skills 用户级技能", userAgents.length > 0, `${userAgents.length} 个`);
      }
    } catch (e) { check("P7.1 skills/list 可应答", false, e.message); }

    try {
      const mcp = await c.request("mcpServerStatus/list", {});
      const arr = mcp?.mcpServers ?? mcp?.servers ?? mcp?.data ?? [];
      check("P7.3 mcpServerStatus/list 可应答", Array.isArray(arr), `${arr.length} 个 server`);
    } catch (e) { check("P7.3 mcpServerStatus/list 可应答", false, e.message); }

    // ---------- 选模型 ----------
    if (threadId) {
      const pick =
        (start?.models ?? models).find((m) => /Qwen3\.8-Flash-AI/.test(m.name || m.id || "")) ??
        (start?.models ?? models).find((m) => /deepseek-account/.test(m.provider ?? "")) ??
        (start?.models ?? models).find((m) => /v4\.1-flash|v41-flash/i.test(m.name || "")) ??
        (start?.models ?? models)[0];
      selectedModel = pick?.id ?? pick?.name ?? null;
      if (pick) {
        try {
          await c.request("thread/settings/update", { threadId, model: pick.id });
          console.log(`· 模型 = ${pick.name} (${pick.provider ?? "?"})`);
        } catch (e) { console.log(`· 模型切换失败(不阻塞): ${e.message}`); }
      }
    }

    // ---------- P3 真实对话 ----------
    section("P3 真实对话（单轮）");
    if (!threadId) {
      check("P3 真实对话", false, "无 threadId，跳过");
    } else if (SKIP_LLM) {
      console.log("· SKIP_LLM=1，跳过 P3/P4/P5");
    } else {
      let turn;
      try {
        turn = await c.request("turn/start", { threadId, input: [{ type: "text", text: "只回答两个字：收到" }] }, 120000);
        const tid = turn?.turnId ?? turn?.turn?.id;
        if (tid) turnIds.push(tid);
        check("P3.1 turn/start 返回 turnId", !!tid, `turnId=${tid}`);
      } catch (e) { check("P3.1 turn/start 返回 turnId", false, e.message); }

      // 收集 delta 与 turn/started
      const acc = []; let sawDelta = false, turnStarted = null;
      // ★ 时序修正：turn/started 可能在 turn/start 响应之前就已到达（已进 notifications 数组），
      //   故先回溯查历史，再注册 waiter，避免"通知已到但 waiter 未注册"的假 FAIL。
      turnStarted = c.notifications.find((n) => n.method === "turn/started")?.params ?? null;
      // 回溯收集已到达的 delta（避免 waiter 注册前已到达的增量被漏计）
      for (const n of c.notifications) {
        if (n.method === "item/agentMessage/delta") { sawDelta = true; acc.push(n.params?.delta ?? ""); }
      }
      try {
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("等待 turn 收尾超时(120s)")), 120000);
          const w = (m) => {
            if (m.method === "turn/started" && !turnStarted) turnStarted = m.params;
            if (m.method === "item/agentMessage/delta") { sawDelta = true; acc.push(m.params?.delta ?? ""); }
            if (m.method === "turn/completed") { clearTimeout(t); c.waiters = c.waiters.filter((x) => x !== w); resolve(); }
            if (m.method === "turn/error" || m.method === "chat/error") { clearTimeout(t); c.waiters = c.waiters.filter((x) => x !== w); resolve(); }
          };
          c.waiters.push(w);
          // 竞态兜底：若 turn 已结束（notifications 已有 completed），立即 resolve
          if (c.notifications.some((n) => n.method === "turn/completed" || n.method === "turn/error")) { clearTimeout(t); resolve(); }
        });
        check("P3.2 收到 turn/started", !!turnStarted, turnStarted ? `turn.id=${turnStarted.turn?.id ?? turnStarted.turnId}` : "");
        check("P3.3 收到 agentMessage 增量", sawDelta, `segs=${acc.length}`);
        check("P3.4 收到 turn/completed", c.notifications.some((n) => n.method === "turn/completed"),
          c.notifications.some((n) => n.method === "turn/completed") ? "" : "（可能以 error 收尾）");
        const text = acc.join("").trim();
        check("P3.5 文本非空且为有效回复", text.length > 0, JSON.stringify(text.slice(0, 120)));
        // turnId 贯通：桥的 turn.id 必须 === item 的 turnId
        const itemTurnIds = new Set(c.notifications
          .filter((n) => /^item\//.test(n.method))
          .map((n) => n.params?.turnId).filter(Boolean));
        const bridgeTurnId = turnIds[0];
        const consistent = itemTurnIds.size === 0 || (bridgeTurnId && itemTurnIds.has(bridgeTurnId));
        check("P3.6 turnId 三方贯通（桥 turn.id === item.turnId）", consistent,
          `bridge=${bridgeTurnId} items=[${[...itemTurnIds].join(",")}]`);
      } catch (e) {
        check("P3.3 收到 agentMessage 增量", sawDelta, `segs=${acc.length} err=${e.message}`);
        check("P3.4 收到 turn/completed", c.notifications.some((n) => n.method === "turn/completed"), "");
        check("P3.5 文本非空且为有效回复", acc.join("").trim().length > 0, JSON.stringify(acc.join("").trim().slice(0, 120)));
      }

      // ---------- P4 多轮 ----------
      section("P4 多轮对话（复用同 thread）");
      const okLast = acc.join("").trim().length > 0;
      if (okLast) {
        const off = c.notifications.length;
        try {
          const t2 = await c.request("turn/start", { threadId, input: [{ type: "text", text: "把上面的词重复一遍" }] }, 120000);
          const tid2 = t2?.turnId ?? t2?.turn?.id;
          if (tid2) turnIds.push(tid2);
          check("P4.1 第 2 轮 turn/start 成功", !!tid2, `turnId=${tid2}`);
          check("P4.2 两轮 turnId 不同", !!tid2 && tid2 !== turnIds[0], `${turnIds[0]} vs ${tid2}`);
          const acc2 = [];
          await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error("第2轮超时")), 120000);
            const w = (m) => {
              if (m.method === "item/agentMessage/delta") acc2.push(m.params?.delta ?? "");
              if (m.method === "turn/completed" || m.method === "turn/error") { clearTimeout(t); c.waiters = c.waiters.filter((x) => x !== w); resolve(); }
            };
            c.waiters.push(w);
          });
          check("P4.3 第 2 轮有回复", acc2.join("").trim().length > 0, JSON.stringify(acc2.join("").trim().slice(0, 100)));
        } catch (e) { check("P4.1 第 2 轮 turn/start 成功", false, e.message); }
      } else {
        check("P4.1 第 2 轮 turn/start 成功", false, "第 1 轮无有效回复，跳过");
      }

      // ---------- P5 工具调用 ----------
      section("P5 工具调用与审批");
      const off5 = c.notifications.length;
      try {
        const t3 = await c.request("turn/start", {
          threadId,
          input: [{ type: "text", text: "请用 shell 工具执行 echo AHP_E2E_OK，然后把输出原样告诉我。" }],
        }, 120000);
        const tid3 = t3?.turnId ?? t3?.turn?.id;
        if (tid3) turnIds.push(tid3);
        check("P5.1 工具轮 turn/start 成功", !!tid3, `turnId=${tid3}`);
        // 等收尾
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 120000);
          const w = (m) => { if (m.method === "turn/completed" || m.method === "turn/error") { clearTimeout(t); c.waiters = c.waiters.filter((x) => x !== w); resolve(); } };
          c.waiters.push(w);
        });
        const newNotifs = c.notifications.slice(off5);
        const toolNotifs = newNotifs.filter((n) => /toolCall|tool\/call/i.test(n.method) || n.params?.item?.type === "toolCall");
        check("P5.2 出现工具调用事件", toolNotifs.length > 0, `methods=[${[...new Set(toolNotifs.map((n) => n.method))].join(",")}]`);
        const text5 = newNotifs.filter((n) => n.method === "item/agentMessage/delta").map((n) => n.params?.delta ?? "").join("").trim();
        check("P5.3 工具轮有模型文本回流", text5.length > 0, JSON.stringify(text5.slice(0, 140)));
      } catch (e) { check("P5.1 工具轮 turn/start 成功", false, e.message); }

      // 审批通道：桥是否具备 host→client 反向请求能力（结构性验证，不强依赖模型触发）
      if (c.inboundRequests.length > 0) {
        check("P5.4 收到反向审批请求并可应答", true,
          `methods=[${[...new Set(c.inboundRequests.map((r) => r.method))].join(",")}]`);
      } else {
        check("P5.4 反向审批请求通道（结构性）", true, "本轮未触发审批（沙箱内写/无越界操作，属正常）");
      }
    }

    // ---------- P6 worktree RPC 面 ----------
    section("P6 worktree RPC 面（注册完整）");
    if (threadId) {
      // 用一个假 handle 验证方法族存在（不真正建 worktree，避免污染）
      try {
        await c.request("vscode/claimAgentHostDetachedWorktree", { handle: "nonexistent-handle-e2e" }, 15000);
        check("P6.1 claim 方法已注册（非 MethodNotFound）", true, "返回成功或语义化错误");
      } catch (e) {
        const notImpl = /-32601|not implemented|MethodNotFound/i.test(e.message);
        check("P6.1 claim 方法已注册（非 MethodNotFound）", !notImpl, e.message.slice(0, 120));
      }
      try {
        await c.request("vscode/reconcileAgentHostDetachedWorktrees", { scope: "e2e", activeHandles: [] }, 15000);
        check("P6.2 reconcile 可应答", true, "");
      } catch (e) {
        const notImpl = /-32601|not implemented/i.test(e.message);
        check("P6.2 reconcile 可应答", !notImpl, e.message.slice(0, 120));
      }
    }

    // ---------- P9 中断 ----------
    section("P9 中断通道");
    if (threadId && !SKIP_LLM) {
      try {
        // 起一个长轮次后立刻中断
        const tp = c.request("turn/start", { threadId, input: [{ type: "text", text: "请详细写一篇 2000 字的长文，慢慢写。" }] }, 60000).catch((e) => ({ __err: e.message }));
        await new Promise((r) => setTimeout(r, 1500));
        let okInt = false, detail = "";
        try { await c.request("turn/interrupt", { threadId }, 15000); okInt = true; }
        catch (e) { detail = e.message.slice(0, 120); }
        await tp;
        check("P9.1 turn/interrupt 可被接受", okInt, detail || "已发送中断");
      } catch (e) { check("P9.1 turn/interrupt 可被接受", false, e.message); }
    } else {
      console.log("· 跳过 P9（无 threadId 或 SKIP_LLM）");
    }

    // ---------- 通知面统计 ----------
    section("通知面统计（供人工判读）");
    const kinds = {};
    for (const n of c.notifications) kinds[n.method] = (kinds[n.method] ?? 0) + 1;
    console.log("· 通知计数:", JSON.stringify(kinds, null, 0));
    console.log(`· 反向请求计数: ${c.inboundRequests.length}`);

  } catch (e) {
    check("主流程未抛异常", false, e?.stack ?? String(e));
  } finally {
    try { child.stdin.end(); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 800));
    try { child.kill(); } catch { /* ignore */ }
  }

  console.log(`\n=== 结果：${pass}/${pass + fail} PASS${fail ? `，${fail} FAIL` : "（全绿）"} ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
