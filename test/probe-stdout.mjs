// 探针：起桥 → 握手 → thread/start → turn/start（用失效模型触发失败）→ 打印桥的全部 stdout 行
import { spawn } from "node:child_process";
import path from "node:path"; import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, "..", "src", "bridge.mjs");
const NODE = process.env.BRIDGE_NODE || process.execPath;
const DSH_BIN = process.env.DSH_BIN || "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";
const CWD = "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30";
const child = spawn(NODE, [BRIDGE, "--node", NODE, "--dsh-bin", DSH_BIN, "--cwd", CWD, "--provider-id", "dsh"],
  { cwd: CWD, stdio: ["pipe","pipe","pipe"], windowsHide: true });
let buf="", id=1; const pend=new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", d => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i+1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { console.log("RAW:", line.slice(0,300)); continue; }
    if (m.id !== undefined) { console.log("RESP id=" + m.id + " " + JSON.stringify(m.result ?? m.error).slice(0,150)); const p=pend.get(m.id); if(p){pend.delete(m.id); m.error?p.rej(new Error(m.error.message)):p.res(m.result);} }
    else console.log("NOTIFY " + m.method + " " + JSON.stringify(m.params).slice(0,300));
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", d => process.stderr.write("[bridge-stderr] " + d));
const req = (method, params) => new Promise((res,rej)=>{ const i=id++; pend.set(i,{res,rej}); child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:i,method,params})+"\n"); setTimeout(()=>{ if(pend.delete(i)) rej(new Error("timeout "+method)); }, 60000); });
await req("initialize", { clientInfo:{name:"probe",version:"0"} });
const st = await req("thread/start", { cwd: CWD, mcpServers: [] });
console.log("threadId=", st.threadId || st.sessionId);
// 用失效的 deepseek-official（key 已知失效）触发失败
await req("thread/settings/update", { threadId: st.threadId||st.sessionId, model: "deepseek-v4-flash" }).catch(e=>console.log("settings:",e.message));
console.log("--- turn/start ---");
const t = await req("turn/start", { threadId: st.threadId||st.sessionId, input:[{type:"text",text:"请用 shell 运行 echo hello"}] });
console.log("turnId=", t.turnId);
await new Promise(r=>setTimeout(r, 8000));
console.log("--- done ---");
child.kill();
