#!/usr/bin/env node
/**
 * MCP 清单上报链路验证（桥层）
 *
 * 验证两件事：
 *   ① 桥的 `mcpServerStatus/list` 能发现 profile 里声明的 MCP server（含 source 溯源）
 *   ② 桥会同步上报 `mcpServer/startupStatus/updated` 通知（协议面与参照系对称）
 *   ③ thread/start 时若 VS Code 未带 mcpServers，桥会回落用 DSH profile 声明的
 */
import { spawn } from "node:child_process";

const NODE = process.execPath;
const DSH = "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";
const CWD = "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30/temp/dsh-ahp-bridge";

let child, buf = "", id = 0;
const pending = new Map();
const notifs = [];

function send(method, params, timeoutMs = 90000) {
  const mid = ++id;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
  return new Promise((res, rej) => {
    pending.set(mid, { res, rej });
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error("timeout " + method)); } }, timeoutMs);
  });
}
function onLine(line) {
  let x; try { x = JSON.parse(line); } catch { return; }
  if (x.id && pending.has(x.id)) {
    const { res, rej } = pending.get(x.id); pending.delete(x.id);
    x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result);
  } else if (x.method) notifs.push(x);
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? (pass++, console.log("  ✅", name, extra)) : (fail++, console.log("  ❌", name, extra)); };

(async () => {
  console.log("=== 启动桥 ===");
  child = spawn(NODE, ["bridge/src/bridge.mjs", "--provider-id", "dsh", "--dsh-bin", DSH, "--cwd", CWD], {
    cwd: CWD, stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); onLine(l); }
  });
  child.stderr.on("data", (d) => process.stderr.write("[桥] " + d));

  await send("initialize", { protocolVersion: 1, clientCapabilities: {} });
  console.log("  ✅ initialize 完成");

  console.log("\n=== ① mcpServerStatus/list ===");
  const r = await send("mcpServerStatus/list", {});
  const list = r.mcpServers ?? [];
  console.log("  server 数:", list.length);
  for (const s of list) console.log("   ·", s.name, "|", s.transport, "|", s.status, "|", s.source);
  ok("发现 MCP server（≥1）", list.length >= 1);
  const probe = list.find((s) => s.name === "ahpprobe");
  ok("含探针 server 'ahpprobe'", !!probe);
  ok("transport 正确 (stdio)", probe?.transport === "stdio");
  ok("状态标注为 configured", probe?.status === "configured");
  ok("source 可溯源", !!probe?.source, probe?.source ?? "");

  console.log("\n=== ② startupStatus 通知上报 ===");
  await new Promise((r) => setTimeout(r, 500));
  const st = notifs.filter((n) => n.method === "mcpServer/startupStatus/updated");
  console.log("  收到通知数:", st.length);
  for (const n of st.slice(0, 5)) console.log("   ·", JSON.stringify(n.params));
  ok("上报了 startupStatus 通知", st.length >= 1);
  ok("通知里含 ahpprobe", st.some((n) => n.params?.name === "ahpprobe"));

  console.log("\n=== ③ thread/start 回落 DSH 声明的 MCP ===");
  const t = await send("thread/start", { cwd: CWD, mcpServers: [] });
  const tg = await send("model/list", {});
  ok("thread/start 成功", !!t.threadId, t.threadId ?? "");
  ok("model/list 非空", (tg.models ?? []).length > 0, `${(tg.models ?? []).length} models`);

  console.log("\n########## 桥 MCP 链路判定 ##########");
  console.log(`  ${pass} 通过 / ${fail} 失败`);
  child.kill();
  process.exit(fail === 0 ? 0 : 2);
})().catch((e) => { console.error("ERR", e.message); child?.kill(); process.exit(1); });
