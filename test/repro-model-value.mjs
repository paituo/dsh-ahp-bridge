// 最小复现：验证「model value 格式」决定成败
//   A) 合法：["lobsterai-custom-0","Qwen3.8-Flash-AI"]  → 应走 ai.jxbw.com，成功
//   B) 非法（VS Code Custom Endpoint 的形态）：customendpoint/Bowei/Qwen3.8-Flash-AI → 应回落 deepseek-official，401
import { spawn } from "node:child_process";
const NODE = process.execPath;
const BIN = "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";

function runCase(label, modelValue) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [BIN, "--profile", "acp"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let buf = "";
    let sid = null;
    const log = [];
    const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");

    child.stdout.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 2 && m.result?.sessionId) {
          sid = m.result.sessionId;
          log.push(`session/new ok: ${sid}`);
          // 设置模型
          send({ jsonrpc: "2.0", id: 3, method: "session/set_config_option",
                 params: { sessionId: sid, configId: "model", value: modelValue } });
        } else if (m.id === 3) {
          log.push(`set_config_option(model="${modelValue}") -> ${m.error ? "ERR " + JSON.stringify(m.error) : "OK"}`);
          // 发一轮 prompt
          setTimeout(() => send({ jsonrpc: "2.0", id: 4, method: "session/prompt",
                                  params: { sessionId: sid, prompt: [{ type: "text", text: "ping" }] } }), 500);
        } else if (m.id === 4) {
          log.push(`session/prompt -> ${m.error ? "ERR " + JSON.stringify(m.error) : "OK " + JSON.stringify(m.result).slice(0, 200)}`);
          setTimeout(() => { child.kill(); resolve(log); }, 500);
        } else if (m.method === "session/update") {
          const u = m.params?.update ?? {};
          if (u.sessionUpdate === "agent_message_chunk" || u.error) {
            log.push(`update: ${JSON.stringify(u).slice(0, 220)}`);
          }
        }
      }
    });
    child.stderr.on("data", (d) => { const s = String(d).trim(); if (s) log.push(`STDERR: ${s.slice(0, 220)}`); });

    send({ jsonrpc: "2.0", id: 1, method: "initialize",
           params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }, clientInfo: { name: "probe", version: "0" } } });
    setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "C:/Users/liuyue", mcpServers: [] } }), 2500);
    setTimeout(() => { try { child.kill(); } catch {} resolve(log.concat("(timeout)")); }, 45000);
  });
}

console.log("========== A) 合法 value: [\"lobsterai-custom-0\",\"Qwen3.8-Flash-AI\"] ==========");
const a = await runCase("A", '["lobsterai-custom-0","Qwen3.8-Flash-AI"]');
console.log(a.join("\n"));

console.log("\n========== B) 非法 value: customendpoint/Bowei/Qwen3.8-Flash-AI ==========");
const b = await runCase("B", "customendpoint/Bowei/Qwen3.8-Flash-AI");
console.log(b.join("\n"));
