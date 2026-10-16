import { spawn } from "node:child_process";
const NODE = process.execPath;
const BIN = "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";
const child = spawn(NODE, [BIN, "--profile", "acp"], { stdio: ["pipe","pipe","pipe"], windowsHide: true });
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stderr.on("data", d => process.stderr.write("ERR: " + d));
let buf="";
child.stdout.on("data", d => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0,i).trim(); buf = buf.slice(i+1);
    if (!line) continue;
    const m = JSON.parse(line);
    console.log("RECV:", JSON.stringify(m, null, 1).slice(0, 3000));
  }
});
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
const CWD_FWD = "C:/Users/liuyue";
send({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:1,clientCapabilities:{fs:{readTextFile:true,writeTextFile:true}},clientInfo:{name:"probe",version:"0"}}});
setTimeout(() => send({jsonrpc:"2.0",id:2,method:"session/new",params:{cwd:CWD_FWD,mcpServers:[]}}), 2500);
setTimeout(() => { console.log("--- done ---"); child.kill(); }, 30000);
