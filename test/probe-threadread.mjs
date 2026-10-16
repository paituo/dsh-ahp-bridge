// 探针：验证 thread/read、thread/unsubscribe、thread/turns/list 及兜底语义化响应
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
child.stdout.on("data", d => { buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i+1);
    if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined) { const p=pend.get(m.id); if(p){pend.delete(m.id); m.error?p.rej(new Error(m.error.message)):p.res(m.result);} } } });
child.stderr.setEncoding("utf8"); child.stderr.on("data", d => process.stderr.write("[b] " + d));
const req = (method, params) => new Promise((res,rej)=>{ const i=id++; pend.set(i,{res,rej}); child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:i,method,params})+"\n"); setTimeout(()=>{ if(pend.delete(i)) rej(new Error("timeout "+method)); }, 40000); });
let pass=0, fail=0; const ok=(c,m)=>{ if(c){pass++;console.log("  ✓ "+m);}else{fail++;console.log("  ✗ "+m);} };
await req("initialize", { clientInfo:{name:"probe",version:"0"} });
console.log("\n[1] thread/read 未知 session（应返回合法空 thread，而非报错）");
try {
  const r = await req("thread/read", { threadId: "f26a84b0-7010-4d06-99a0-78f66bf8a8be", includeTurns: false });
  console.log("  result:", JSON.stringify(r).slice(0,220));
  ok(r && r.thread, "有 thread 字段");
  ok(r.thread.id === "f26a84b0-7010-4d06-99a0-78f66bf8a8be", "thread.id 等于请求 id");
  ok(r.thread.status && ["idle","active"].includes(r.thread.status.type), "status.type ∈ {idle,active}");
  ok(r.thread.historyMode !== "paginated", "非 paginated（一次取全量）");
  ok(Array.isArray(r.thread.turns), "turns 为数组");
} catch(e) { console.log("  ✗ 抛错:", e.message); fail++; }
console.log("\n[2] thread/unsubscribe（幂等空成功）");
try { const r = await req("thread/unsubscribe", { threadId:"x" }); ok(r && typeof r==="object", "返回对象"); } catch(e){ ok(false, "抛错:"+e.message); }
console.log("\n[3] thread/turns/list（空列表+游标）");
try { const r = await req("thread/turns/list", { threadId:"x" }); ok(r && Array.isArray(r.turns) && r.nextCursor===null, "返回 {turns:[],nextCursor:null}"); } catch(e){ ok(false,"抛错:"+e.message); }
console.log("\n[4] 兜底语义化：account/read → {account:null}（非 MethodNotFound）");
try { const r = await req("account/read", {}); console.log("  result:", JSON.stringify(r)); ok(r && "account" in r, "有 account 字段"); } catch(e){ ok(false,"抛错(不应):"+e.message); }
console.log("\n[5] 兜底语义化：config/read → {}");
try { const r = await req("config/read", {}); ok(r && typeof r==="object", "返回对象"); } catch(e){ ok(false,"抛错:"+e.message); }
console.log("\n[6] 真未知方法 → 仍 MethodNotFound");
try { await req("totally/unknown/method", {}); ok(false, "不应成功"); } catch(e){ ok(/not implemented|not found/i.test(e.message), "MethodNotFound: "+e.message.slice(0,60)); }
console.log(`\n结果: ${pass} passed, ${fail} failed\n`);
child.kill(); process.exit(fail?1:0);
