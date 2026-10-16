#!/usr/bin/env node
/** 多真实 MCP server 协议面横向自检（不含 DSH，只验 server 自身合规 + 可调用） */
import { spawn } from "node:child_process";

const NPX = "C:/Users/liuyue/.workbuddy/binaries/node/versions/22.22.2-2/npx.cmd";
const TMP = "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30/temp/real-mcp-fsroot";

const CASES = [
  { name: "everything", args: ["--yes", "@modelcontextprotocol/server-everything", "stdio"],
    call: { tool: "get-sum", args: { a: 11, b: 22 }, expect: /33/ } },
  { name: "memory", args: ["--yes", "@modelcontextprotocol/server-memory"],
    call: null },
  { name: "filesystem", args: ["--yes", "@modelcontextprotocol/server-filesystem", TMP],
    call: null },
  { name: "sequential-thinking", args: ["--yes", "@modelcontextprotocol/server-sequential-thinking"],
    call: { tool: "sequentialthinking", args: { thought: "probe step", nextThoughtNeeded: false, thoughtNumber: 1, totalThoughts: 1 }, expect: /.+/ } },
];

async function probe(c) {
  return new Promise((resolve) => {
    const child = spawn(NPX, c.args, { stdio: ["pipe", "pipe", "pipe"], shell: true });
    let buf = "", id = 0; const pending = new Map();
    const out = { name: c.name, up: false, tools: [], serverInfo: null, caps: [], callOk: null, err: null };
    const send = (method, params, ms = 60000) => {
      const mid = ++id;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
      return new Promise((res, rej) => {
        pending.set(mid, { res, rej });
        setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error("timeout " + method)); } }, ms);
      });
    };
    child.stdout.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1);
        let x; try { x = JSON.parse(l); } catch { continue; }
        if (x.id && pending.has(x.id)) { const { res, rej } = pending.get(x.id); pending.delete(x.id); x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result); }
      }
    });
    child.stderr.on("data", () => {});
    (async () => {
      try {
        const init = await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "p", version: "1" } });
        out.up = true; out.serverInfo = init.serverInfo; out.caps = Object.keys(init.capabilities ?? {});
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        const tl = await send("tools/list", {});
        out.tools = (tl.tools ?? []).map((t) => t.name);
        if (c.call) {
          const r = await send("tools/call", { name: c.call.tool, arguments: c.call.args });
          const txt = (r.content ?? []).map((x) => x.text ?? "").join("");
          out.callOk = c.call.expect ? c.call.expect.test(txt) : txt.length > 0;
          out.callSnippet = txt.slice(0, 120);
        }
      } catch (e) { out.err = e.message; }
      child.kill();
      resolve(out);
    })();
  });
}

const results = [];
for (const c of CASES) results.push(await probe(c));

console.log("\n########## 多真实 MCP server 协议面自检 ##########\n");
for (const r of results) {
  console.log(`■ ${r.name}`);
  console.log(`  启动: ${r.up ? "✅" : "❌ " + (r.err || "")}`);
  if (r.serverInfo) console.log(`  serverInfo: ${r.serverInfo.name} v${r.serverInfo.version}`);
  console.log(`  能力: ${r.caps.join(", ")}`);
  console.log(`  工具(${r.tools.length}): ${r.tools.slice(0, 8).join(", ")}${r.tools.length > 8 ? " …" : ""}`);
  if (r.callSnippet !== undefined) console.log(`  调用验证: ${r.callOk ? "✅" : "❌"} | ${JSON.stringify(r.callSnippet)}`);
  console.log("");
}
const bad = results.filter((r) => !r.up || r.callOk === false);
console.log(bad.length ? `失败: ${bad.map((b) => b.name).join(", ")}` : "全部真实 server 启动正常");
process.exit(bad.length ? 1 : 0);
