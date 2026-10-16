// 决定性实验 C：不设置任何 model，直接用 DSH 默认模型发 prompt
//   若也报 38Bf 401 ⇒ 证明 deepseek-official provider 用的 key 就是 38Bf（jxbw 的 key）——即配置错配
//   若不报错 ⇒ 说明默认 provider/key 正常，问题确实在 model 设置
import { spawn } from "node:child_process";
const NODE = process.execPath;
const BIN = "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";

const child = spawn(NODE, [BIN, "--profile", "acp"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
let buf = "";
let sid = null;
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");

child.stdout.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 2 && m.result?.sessionId) {
      sid = m.result.sessionId;
      // ★ 打印 configOptions 里的 currentValue（默认模型）
      const modelOpt = (m.result.configOptions ?? []).find((o) => o.id === "model");
      console.log(`[C] session/new ok. 默认 model currentValue = ${JSON.stringify(modelOpt?.currentValue)}`);
      console.log(`[C] 不设置 model，直接 prompt ...`);
      send({ jsonrpc: "2.0", id: 4, method: "session/prompt",
             params: { sessionId: sid, prompt: [{ type: "text", text: "ping" }] } });
    } else if (m.id === 4) {
      console.log(`[C] session/prompt -> ${m.error ? "ERR " + JSON.stringify(m.error) : "OK " + JSON.stringify(m.result)}`);
      setTimeout(() => { child.kill(); process.exit(0); }, 500);
    } else if (m.method === "session/update") {
      const u = m.params?.update ?? {};
      if (u.sessionUpdate === "agent_message_chunk") {
        console.log(`[C] ★ 收到回复: ${JSON.stringify(u.content?.text ?? u.content)}`);
      }
    }
  }
});
child.stderr.on("data", (d) => { const s = String(d).trim(); if (s) console.log("[C] STDERR: " + s.slice(0, 300)); });

send({ jsonrpc: "2.0", id: 1, method: "initialize",
       params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }, clientInfo: { name: "probe", version: "0" } } });
setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "C:/Users/liuyue", mcpServers: [] } }), 2500);
setTimeout(() => { try { child.kill(); } catch {} console.log("[C] (timeout)"); process.exit(0); }, 60000);
