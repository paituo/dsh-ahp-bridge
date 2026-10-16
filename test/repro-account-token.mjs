// 实验 F：清空 DEEPSEEK_API_KEY，看 deepseek-official 是否回落到 account token（OAuth）并成功
import { spawn } from "node:child_process";
const NODE = process.execPath;
const BIN = "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";

const env = { ...process.env };
// 删除从凭据文件来的 DEEPSEEK_API_KEY（注意：DSH 会从 ~/.dsh/.credentials.yaml 读 refs，
// 该文件里 DEEPSEEK_API_KEY 仍然存在；这里用环境变量覆盖为空串，先测环境变量优先级）
env.DEEPSEEK_API_KEY = "";

const child = spawn(NODE, [BIN, "--profile", "acp"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
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
      console.log(`[F] session/new ok`);
      send({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "text", text: "ping" }] } });
    } else if (m.id === 4) {
      console.log(`[F] session/prompt -> ${m.error ? "ERR " + JSON.stringify(m.error) : "OK " + JSON.stringify(m.result)}`);
      setTimeout(() => { child.kill(); process.exit(0); }, 500);
    } else if (m.method === "session/update") {
      const u = m.params?.update ?? {};
      if (u.sessionUpdate === "agent_message_chunk") console.log(`[F] ★ 回复: ${JSON.stringify(u.content?.text ?? u.content)}`);
    }
  }
});
child.stderr.on("data", (d) => { const s = String(d).trim(); if (s) console.log("[F] STDERR: " + s.slice(0, 300)); });
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }, clientInfo: { name: "probe", version: "0" } } });
setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "C:/Users/liuyue", mcpServers: [] } }), 2500);
setTimeout(() => { try { child.kill(); } catch {} console.log("[F] (timeout)"); process.exit(0); }, 60000);
