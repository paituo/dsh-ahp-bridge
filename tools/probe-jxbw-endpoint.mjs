import { spawn } from "node:child_process";
const NODE="E:/分析数据/DeepSeek-Harness-VSCode/runtime/node/node.exe";
const BIN="E:/分析数据/DeepSeek-Harness-VSCode/dev/dsh/lib/bin.js";
const CWD="E:/分析数据/DeepSeek-Harness-VSCode/dev";
const p=spawn(NODE,[BIN,"--profile","acp"],{cwd:CWD,stdio:["pipe","pipe","pipe"],windowsHide:true});
p.stderr.on("data",d=>process.stderr.write("[dsh] "+d));
const send=o=>p.stdin.write(JSON.stringify(o)+"\n");
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let pending=new Map();
p.stdout.on("data",d=>{for(const line of d.toString().split("\n")){if(!line.trim())continue;try{const j=JSON.parse(line);if(j.id!==undefined&&pending.has(j.id)){pending.get(j.id)(j);pending.delete(j.id);}}catch{}}});
const rpc=(id,method,params)=>new Promise(res=>{pending.set(id,res);send({jsonrpc:"2.0",id,method,params});setTimeout(()=>pending.has(id)&&(pending.delete(id),res({timeout:true})),40000);});
(async()=>{
  await rpc(1,"initialize",{protocolVersion:1,clientCapabilities:{}});
  const sn=await rpc(2,"session/new",{cwd:CWD,mcpServers:[]});
  const sid=sn?.result?.sessionId;
  console.log("sessionId=",sid,"\n默认模型=",sn.result.configOptions?.[0]?.currentValue);
  // 不改模型，直接用 DSH pinned 默认发 prompt
  const pr=await rpc(3,"session/prompt",{sessionId:sid,prompt:[{type:"text",text:"说一个字：好"}]});
  console.log("\n=== 默认模型(lobsterai-custom-0) prompt 回执 ===");
  console.log(JSON.stringify(pr).slice(0,700));
  p.kill();process.exit(0);
})();
