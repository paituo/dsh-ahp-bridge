// 验证第二问：已建立的会话（不是新建的）是否会收到 config_option_update 推送。
// 这在「桥持有长会话 + 运行中注入 provider」的场景下是决定性的。
import { spawn } from "node:child_process";
import fs from "node:fs";

const NODE = "C:/Users/liuyue/.workbuddy/binaries/node/versions/22.22.2-2/node.exe";
const BIN = "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";
const PATCH = "C:/Users/liuyue/.dsh/profiles/acp/cordis.patch.yml";
const CWD = "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30/temp/dsh-ahp-bridge";
const original = fs.readFileSync(PATCH, "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child, buf = "", id = 0;
const pending = new Map();
const cfgUpdates = [];   // 收到的 config_option_update 通知

function send(m, p) {
  const mid = ++id;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method: m, params: p }) + "\n");
  return new Promise((res, rej) => {
    pending.set(mid, { res, rej });
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error("timeout " + m)); } }, 90000);
  });
}
function onLine(l) {
  let x; try { x = JSON.parse(l); } catch { return; }
  if (x.id && pending.has(x.id)) { const { res, rej } = pending.get(x.id); pending.delete(x.id); x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result); return; }
  if (x.method === "session/update") {
    const u = x.params?.update;
    if (u?.sessionUpdate === "config_option_update" || u?.sessionUpdate === "available_commands_update") {
      cfgUpdates.push({ t: Date.now(), kind: u.sessionUpdate, groups: u.configOptions?.[0]?.options?.length ?? null });
    }
  }
}
function groupNames(cfg) {
  const co = cfg?.configOptions || [];
  const mo = co.find(o => o.id === "model");
  return (mo?.options || []).map(g => g.group ?? g.name);
}

try {
  console.log("=== 启动 DSH acp ===");
  child = spawn(NODE, [BIN, "--profile", "acp"], { cwd: CWD, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); onLine(l); } });
  child.stderr.on("data", () => {});

  await send("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const s1 = await send("session/new", { cwd: CWD, mcpServers: [] });
  const sid = s1.sessionId;
  console.log("已建立长会话:", sid);
  console.log("会话建立时分组:", groupNames(s1).join(", "));

  const before = cfgUpdates.length;

  console.log("\n=== 运行中改写 patch（追加 live-session-probe）===");
  const modified = original.replace(`      bumen:`,
    `      live-session-probe:
        displayName: LiveSessionProbe
        apiKeyEnv: LOBSTERAI_CUSTOM_0_API_KEY
        api: openai-completions
        baseURL: https://ai.jxbw.com/v1
        models:
          - id: Qwen3.8-Flash-AI
            name: Qwen3.8-Flash-AI
      bumen:`);
  if (modified === original) throw new Error("锚点未命中");
  fs.writeFileSync(PATCH, modified, "utf8");

  console.log("等待推送（最多 15s）...");
  await sleep(15000);

  const newUpdates = cfgUpdates.slice(before);
  console.log(`\n收到 config 推送条数: ${newUpdates.length}`);
  for (const u of newUpdates) console.log("   ", JSON.stringify(u));
  if (newUpdates.length) {
    console.log("→ 推送中最新分组数:", newUpdates[newUpdates.length - 1].groups);
  }

  console.log("\n########## 判定 ##########");
  if (newUpdates.length > 0) {
    console.log("✅ 已建立的会话会收到 config_option_update 主动推送 → 桥可直接刷新 VS Code 模型下拉");
  } else {
    console.log("△ 未收到主动推送（provider 已注册，但旧会话未被通知）→ 桥需在新建会话/首次查询时自然获得");
    console.log("  （这仍是可用的：AcpModelControl.state() 实时 listProviders，新会话/重查即可见）");
  }
} catch (e) {
  console.log("✗ 异常:", e.message);
} finally {
  try { fs.writeFileSync(PATCH, original, "utf8"); console.log("\n[patch 已还原]"); } catch (e) { console.log("还原失败:", e.message); }
  try { child && child.kill(); } catch {}
  await sleep(800); process.exit(0);
}
