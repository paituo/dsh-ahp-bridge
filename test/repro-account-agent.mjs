// 实验 G：显式使用 deepseek-account（OAuth 授权链路），确认是否可用
import { spawn } from "node:child_process";
const NODE = process.execPath;
const BIN = "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";

const child = spawn(NODE, [BIN, "--profile", "acp"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
let buf = "", sid = null;
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");

child.stdout.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 2 && m.result?.sessionId) {
      sid = m.result.sessionId;
      console.log(`[G] session/new ok`);
      send({ jsonrpc: "2.0", id: 3, method: "session/set_config_option",
             params: { sessionId: sid, configId: "model", value: '["deepseek-account","deepseek-flash"]' } });
    } else if (m.id === 3) {
      console.log(`[G] set_config_option(deepseek-account) -> ${m.error ? "ERR " + JSON.stringify(m.error) : "OK"}`);
      send({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "text", text: "ping" }] } });
    } else if (m.id === 4) {
      console.log(`[G] session/prompt -> ${m.error ? "ERR " + JSON.stringify(m.error) : "OK " + JSON.stringify(m.result)}`);
      setTimeout(() => { child.kill(); process.exit(0); }, 500);
    } else if (m.method === "session/update") {
      const u = m.params?.update ?? {};
      if (u.sessionUpdate === "agent_message_chunk") console.log(`[G] ★ 回复: ${JSON.stringify(u.content?.text ?? u.content)}`);
    }
  }
});
child.stderr.on("data", (d) => { const s = String(d).trim(); if (s) console.log("[G] STDERR: " + s.slice(0, 300)); });
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }, clientInfo: { name: "probe", version: "0" } } });
setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "C:/Users/liuyue", mcpServers: [] } }), 2500);
setTimeout(() => { try { child.kill(); } catch {} console.log("[G] (timeout)"); process.exit(0); }, 60000);
