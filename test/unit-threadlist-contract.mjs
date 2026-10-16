/**
 * 单测：thread/list 必须符合 main bundle 的**实测契约**。
 *   契约（来自 agentHostMain.js::sessionsDiscoveryScan + _threadToMetadata + cQ）：
 *     请求 : { limit:100, modelProviders:[], cursor?, useStateDbOnly, sortKey:"updated_at" }
 *     响应 : { data:[...], nextCursor? }
 *     字段 : id(裸) / createdAt(秒) / updatedAt(秒) / name? / preview? / cwd? / source / path? / modelProvider?
 *     id   : 裸 form（VS Code 自拼 `dsh:/<id>`）；**绝不** `dsh:/` 或 `session-` 前缀
 *
 * 做法：起一座真桥，发 thread/list，校验响应结构 + 字段类型。
 */
import { spawn } from "node:child_process";
import readline from "node:readline";

const NODE = "C:/Users/liuyue/.workbuddy/binaries/node/versions/22.22.2-2/node.exe";
const BRIDGE = "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30/temp/dsh-ahp-bridge/bridge/src/bridge.mjs";
const DSH_BIN = "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";
const CWD = "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30";

const child = spawn(NODE, [BRIDGE, "--provider-id", "dsh", "--dsh-bin", DSH_BIN, "--cwd", CWD], {
  cwd: CWD, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
});
child.stderr.setEncoding("utf8");
let bridgeLog = [];
child.stderr.on("data", (d) => bridgeLog.push(String(d).trimEnd()));

const rl = readline.createInterface({ input: child.stdout });
let nextId = 1;
const pending = new Map();
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id != null && pending.has(msg.id)) { const { resolve } = pending.get(msg.id); pending.delete(msg.id); resolve(msg); }
});
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: { message: "timeout" } }); } }, 60000);
  });
}
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

const results = [];
const ok = (cond, label) => { results.push(!!cond); console.log(`  ${cond ? "✓" : "✗"} ${label}`); };

console.log("=== initialize 握手 ===");
const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "unit-threadlist", version: "0" } });
ok(init.result?.serverInfo?.name, `initialize ok: ${init.result?.serverInfo?.name}`);
notify("initialized", {});

console.log("\n=== thread/list 契约 ===");
const r1 = await request("thread/list", { limit: 100, modelProviders: [], sortKey: "updated_at" });
const R = r1.result;
ok(R && !R.error, "有正常响应");
ok(R && Array.isArray(R.data), "★ 响应含 data 数组（非 threads）");
ok(R && !("threads" in R), "★ 响应不含旧的 threads 键");
ok(R && Array.isArray(R.data) && R.data.length > 0, `data 非空（${R?.data?.length ?? 0} 条）`);

if (R?.data?.length) {
  const it = R.data[0];
  ok(typeof it.id === "string" && it.id.length > 0, `item.id 是非空字符串: ${it.id}`);
  ok(!String(it.id).startsWith("dsh:/"), "★ item.id 无 dsh:/ 前缀（VS Code 自拼）");
  ok(!String(it.id).startsWith("session-"), "★ item.id 无 session- 前缀");
  ok(typeof it.createdAt === "number" && it.createdAt < 1e12, `★ createdAt 是秒级（${it.createdAt}）`);
  ok(typeof it.updatedAt === "number" && it.updatedAt < 1e12, `★ updatedAt 是秒级（${it.updatedAt}）`);
  ok(it.source !== undefined, `item.source 存在: ${JSON.stringify(it.source)}`);
  ok(it.parentThreadId === undefined || !it.parentThreadId, "★ parentThreadId 为 falsy（顶层会话）");
  // 额外：id 形态是 uuid
  ok(/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(it.id), `id 是 uuid 形态`);
  console.log("     样例 item:", JSON.stringify(it));
}

console.log("\n=== 分页透传（cursor）===");
const r2 = await request("thread/list", { limit: 5, modelProviders: [], sortKey: "updated_at" });
const R2 = r2.result;
ok(Array.isArray(R2?.data), "limit=5 时仍返回 data");
console.log(`     limit=5 → data.length=${R2?.data?.length}, nextCursor=${R2?.nextCursor ? "有" : "无"}`);
if (R2?.nextCursor) {
  const r3 = await request("thread/list", { limit: 5, modelProviders: [], cursor: R2.nextCursor, sortKey: "updated_at" });
  const R3 = r3.result;
  ok(Array.isArray(R3?.data), "带 cursor 的第二页返回 data");
  const firstIds = new Set((R2.data || []).map((x) => x.id));
  const overlap = (R3?.data || []).filter((x) => firstIds.has(x.id)).length;
  ok(overlap === 0, `第二页与第一页无重叠（overlap=${overlap}）`);
}

console.log(`\n=== ${results.filter(Boolean).length}/${results.length} PASS ===`);
console.log("--- bridge log tail ---");
bridgeLog.slice(-6).forEach((l) => console.log("   " + l));
try { child.stdin.end(); } catch {}
setTimeout(() => process.exit(results.filter(Boolean).length === results.length ? 0 : 1), 300);
