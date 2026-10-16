#!/usr/bin/env node
/**
 * MCP 链路端到端验证（DSH ACP 层）
 *
 * 目标：证明 MCP server 的工具**真的能被模型调用**（不只是列出来）。
 *
 * ★ 权威事实（2026-10-11 源码实证，勿再假设 profile 注册）：
 *   DSH 的 ACP 路径**不支持**用 cordis.patch.yml 注册 mcp-client
 *   （patch 只能覆盖已存在条目，新增会报 `entry "mcp-client" not found`）。
 *   MCP 是**会话级挂载**：必须在 `session/new` 的 `mcpServers` 里声明，
 *   且 schema 为 { name, command(绝对路径), args?, env?: [{name,value}] }。
 *   ★ env 必传（源码 for..of 无 ??[] 兜底，缺 env 抛 TypeError 静默挂载失败）。
 *
 * 步骤：
 *   1. 起 DSH（acp profile）
 *   2. initialize + session/new（带权威 schema 的 mcpServers）
 *   3. prompt 让模型调用 mcp__ahpprobe__echo 与 mcp__ahpprobe__add
 *   4. 断言：出现 MCP_ECHO_OK / MCP_ADD_RESULT: 42（= 工具真执行），
 *      且确有 tool_call 事件 title 为 mcp__ahpprobe__*
 */
import { spawn } from "node:child_process";
import path from "node:path";

const NODE = process.execPath;
const DSH = "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";
const CWD = "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30/temp/dsh-ahp-bridge";
const PROBE = path.join(CWD, "bridge", "test", "temp-mcp-server-stdio.mjs").replace(/\\/g, "/");

const MODEL = process.argv[2] ?? "Qwen3.8-Flash-AI";

let child;
let buf = "";
let id = 0;
const pending = new Map();
const notifs = [];

function send(method, params, timeoutMs = 180000) {
  const mid = ++id;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
  return new Promise((res, rej) => {
    pending.set(mid, { res, rej });
    setTimeout(() => {
      if (pending.has(mid)) { pending.delete(mid); rej(new Error("timeout " + method)); }
    }, timeoutMs);
  });
}
function onLine(line) {
  let x;
  try { x = JSON.parse(line); } catch { return; }
  if (x.id && pending.has(x.id)) {
    const { res, rej } = pending.get(x.id);
    pending.delete(x.id);
    x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result);
  } else if (x.method) {
    notifs.push(x);
  }
}

(async () => {
  child = spawn(NODE, [DSH, "--profile", "acp"], { cwd: CWD, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); onLine(l); }
  });
  child.stderr.on("data", (d) => process.stderr.write("[dsh] " + d));

  await send("initialize", { protocolVersion: 1, clientCapabilities: { fs: {} } });
  // ★ 权威 schema：name / command(绝对路径) / args / env(必传)
  const s = await send("session/new", {
    cwd: CWD,
    mcpServers: [{ name: "ahpprobe", command: NODE.replace(/\\/g, "/"), args: [PROBE], env: [] }],
  }, 120000);
  const sid = s.sessionId;
  console.log("session:", sid);

  // 找目标模型并切换
  const opts = s.configOptions?.find((o) => o.id === "model");
  const groups = opts?.options ?? [];
  let targetValue = null, targetLabel = null;
  for (const g of groups) {
    for (const m of (g.options ?? [])) {
      let v = m.value;
      if (typeof v === "string") { try { v = JSON.parse(v); } catch {} }
      if (Array.isArray(v) && v[1] === MODEL) { targetValue = m.value; targetLabel = `${v[0]} / ${v[1]}`; }
    }
  }
  console.log("目标模型:", targetLabel ?? "(未在列表中)");
  if (targetValue) {
    await send("session/set_config_option", { sessionId: sid, configId: "model", value: targetValue });
    console.log("已切换到:", targetLabel);
  }

  // ★ 关键：让模型调用 MCP 工具
  const prompt = [
    "请调用 MCP 工具完成两件事，并把工具的原始返回值原样贴出来：",
    "1. 调用 ahpprobe 服务器的 echo 工具，text 参数填 \"ahp-mcp-check\"",
    "2. 调用 ahpprobe 服务器的 add 工具，a=17, b=25",
    "工具名形如 mcp__ahpprobe__echo 和 mcp__ahpprobe__add。必须真实调用工具，不要自己编造结果。",
  ].join("\n");

  console.log("\n=== 发 prompt（要求真实调用 MCP 工具）===");
  const started = Date.now();
  await send("session/prompt", {
    sessionId: sid,
    prompt: [{ type: "text", text: prompt }],
  });

  const elapsed = Date.now() - started;
  const text = notifs
    .filter((n) => n.params?.update?.sessionUpdate === "agent_message_chunk")
    .map((n) => n.params.update.content?.text ?? "")
    .join("");
  const toolCalls = notifs.filter((n) => {
    const u = n.params?.update;
    return u && (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update");
  });
  const done = notifs.find((n) => n.params?.update?.sessionUpdate === "turn_completed" || n.params?.stopReason);

  console.log("耗时:", elapsed, "ms");
  console.log("工具调用事件数:", toolCalls.length);
  for (const t of toolCalls.slice(0, 6)) {
    const title = t.params.update.title ?? t.params.update.kind ?? "";
    console.log("  ·", t.params.update.sessionUpdate, "|", title);
  }
  console.log("\n--- 模型输出（前 900 字）---");
  console.log(text.slice(0, 900));

  const okEcho = /MCP_ECHO_OK/.test(text) || JSON.stringify(toolCalls).includes("MCP_ECHO_OK");
  const okAdd = /MCP_ADD_RESULT:?\s*42/.test(text) || JSON.stringify(toolCalls).includes("MCP_ADD_RESULT: 42");
  // ★ 加固：必须确有 mcp__ 工具调用事件（防止模型"只复述源码常量"的假阳性）
  const realMcp = toolCalls.some((t) => /mcp__ahpprobe__/.test(String(t.params?.update?.title ?? "")));

  console.log("\n########## MCP 链路判定 ##########");
  console.log("echo 工具真实执行:", okEcho ? "✅" : "❌");
  console.log("add  工具真实执行:", okAdd ? "✅" : "❌");
  console.log("确有 mcp__ 工具调用事件:", realMcp ? "✅" : "❌");

  child.kill();
  process.exit(okEcho && okAdd && realMcp ? 0 : 2);
})().catch((e) => { console.error("ERR", e.message); child?.kill(); process.exit(1); });
