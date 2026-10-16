#!/usr/bin/env node
/**
 * 深挖：agent picker 下拉项只有 ["Agent","配置自定义 Agent..."] 时，
 * 检查 renderer 侧 agent 文件发现机制：
 *   1. 页面里能否看到 promptsService / getCustomAgents 相关全局
 *   2. VS Code 用户数据目录下的 agent 存储（globalStorage / 内置 copilot 目录）
 *   3. ~/.copilot/agents 是否被扫描（看 VS Code 日志）
 */
const PORT = process.argv[2] || "9333";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
const pages = list.filter((p) => p.type === "page");
console.log("pages:", pages.map((p) => p.title).join(" | "));

// ① 找 renderer 主页面（非 Agent 窗口那个）
const mainPg = pages.find((p) => /Visual Studio Code$/i.test(p.title || "")) || pages[0];
const ws = new WebSocket(mainPg.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data.toString()); if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Runtime.enable");
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};

// ② 探测全局是否有 VS Code 服务
const probe = await ev("(() => {"
  + "const keys=Object.keys(window).filter(k=>/service|prompt|agent|copilot|chat/i.test(k));"
  + "return JSON.stringify({ winKeys: keys.slice(0,40), hasRequire: typeof require, hasModule: typeof module });"
  + "})()");
console.log("\nrenderer 全局探针:", probe);

// ③ 文件系统侧：agent 文件候选目录清单
const candidates = [
  path.join(os.homedir(), ".copilot", "agents"),
  path.join(os.homedir(), ".claude", "agents"),
  "C:/Users/liuyue/AppData/Roaming/Code/User/prompts",
  "C:/Users/liuyue/AppData/Roaming/Code/User/globalStorage/github.copilot-chat",
  "C:/Users/liuyue/AppData/Roaming/Code/User/globalStorage",
];
console.log("\n──── agent 文件候选目录 ────");
for (const c of candidates) {
  try {
    const st = fs.statSync(c);
    if (st.isDirectory()) {
      const files = fs.readdirSync(c).slice(0, 20);
      console.log("  ✅ " + c + "  (" + files.length + " 项): " + JSON.stringify(files));
    }
  } catch (e) { console.log("  ❌ " + c + "  —— " + e.code); }
}

ws.close(); process.exit(0);
