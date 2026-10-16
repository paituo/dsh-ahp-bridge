import { spawn } from "node:child_process";
const NODE="E:/分析数据/DeepSeek-Harness-VSCode/runtime/node/node.exe";
const BIN="E:/分析数据/DeepSeek-Harness-VSCode/dev/dsh/lib/bin.js";
const CWD="E:/分析数据/DeepSeek-Harness-VSCode/dev";
const p=spawn(NODE,[BIN,"--profile","acp"],{cwd:CWD,stdio:["pipe","pipe","pipe"],windowsHide:true});
const send=o=>p.stdin.write(JSON.stringify(o)+"\n");
let pending=new Map();
p.stdout.on("data",d=>{for(const line of d.toString().split("\n")){if(!line.trim())continue;try{const j=JSON.parse(line);if(j.id!==undefined&&pending.has(j.id)){pending.get(j.id)(j);pending.delete(j.id);}}catch{}}});
const rpc=(id,method,params)=>new Promise(res=>{pending.set(id,res);send({jsonrpc:"2.0",id,method,params});setTimeout(()=>pending.has(id)&&(pending.delete(id),res({timeout:true})),40000);});
const cv=r=>r?.result?.configOptions?.find(o=>o.id==="model")?.currentValue;
(async()=>{
  await rpc(1,"initialize",{protocolVersion:1,clientCapabilities:{}});
  const sn=await rpc(2,"session/new",{cwd:CWD,mcpServers:[]});
  const sid=sn.result.sessionId;
  console.log("1. new 后 currentValue =", cv(sn));
  const s1=await rpc(3,"session/set_config_option",{sessionId:sid,configId:"model",value:'["deepseek-official","deepseek-flash"]'});
  console.log("2. set(deepseek-official) 后回读 =", cv(s1));
  const pr=await rpc(4,"session/prompt",{sessionId:sid,prompt:[{type:"text",text:"hi"}]});
  console.log("3. prompt 结果 =", pr.error?("ERR: "+pr.error.message.slice(0,120)):"OK");
  // ★ 关键：turn 失败后 currentValue 变成了什么？
  const s2=await rpc(5,"session/set_config_option",{sessionId:sid,configId:"model",value:'["deepseek-official","deepseek-flash"]'});
  console.log("4. 再 set 后回读 =", cv(s2));
  // 再用 bumen 试
  const s3=await rpc(6,"session/set_config_option",{sessionId:sid,configId:"model",value:'["bumen","deepseek-v4.1-flash"]'});
  console.log("5. set(bumen) 回读 =", cv(s3));
  const pr2=await rpc(7,"session/prompt",{sessionId:sid,prompt:[{type:"text",text:"hi"}]});
  console.log("6. bumen prompt =", pr2.error?("ERR: "+pr2.error.message.slice(0,120)):"OK ✅");
  p.kill();process.exit(0);
})();
