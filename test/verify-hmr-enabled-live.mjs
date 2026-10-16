// 真机端到端验证（修正版）：acp profile 启用 hmr 后，运行中改 cordis.patch.yml 是否热加载 provider。
// 正确解析 configOptions：options[0] 为 model 下拉，其 options 为分组，叶子为 ["provider","model"] JSON 字符串。
// 闭环判定：热加载后分组出现 -> 用叶子 value 真实 set_config_option -> 发 prompt -> 收到文本。
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
const updates = [];

function send(method, params) {
  const mid = ++id;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
  return new Promise((res, rej) => {
    pending.set(mid, { res, rej });
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`timeout: ${method}`)); } }, 90000);
  });
}
function notify(method, params) { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); }

function onLine(line) {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    return;
  }
  if (msg.method === "session/update") updates.push(msg.params);
}

// 正确解析：返回 { groups: [{group,name,models:[{value,name}]}], flat: [{value,name,group}] }
function parseModels(cfg) {
  const co = cfg.configOptions || cfg.options || [];
  const modelOpt = co.find((o) => o.id === "model" || o.category === "model");
  const groups = [], flat = [];
  for (const g of (modelOpt?.options || [])) {
    const gm = [];
    for (const v of (g.options || [])) {
      const item = { value: String(v.value), name: String(v.name ?? v.value), group: String(g.group ?? g.name) };
      gm.push(item); flat.push(item);
    }
    groups.push({ group: String(g.group ?? g.name), name: String(g.name ?? g.group), models: gm });
  }
  return { groups, flat };
}

function summarize(tag, parsed) {
  console.log(`\n--- ${tag} | ${parsed.groups.length} 个分组 / ${parsed.flat.length} 个模型 ---`);
  for (const g of parsed.groups) console.log(`   [${g.group}] ${g.name}: ${g.models.map((m) => m.name).join(", ")}`);
}

try {
  console.log("=== 启动 DSH acp（hmr disabled:false, root:[]）===");
  child = spawn(NODE, [BIN, "--profile", "acp"], { cwd: CWD, stdio: ["pipe", "pipe", "pipe"] });
  let stderrAll = "";
  child.stdout.on("data", (d) => { buf += d.toString("utf8"); let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); onLine(l); } });
  child.stderr.on("data", (d) => { stderrAll += d.toString("utf8"); });

  await send("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const s1 = await send("session/new", { cwd: CWD, mcpServers: [] });
  const sid = s1.sessionId;
  const base = parseModels(s1);
  summarize("① 基线", base);
  const baseHasGroup = base.groups.some((g) => /hot-probe-0/.test(g.group));

  // 运行中改 patch：追加 hot-probe-0（providers 为整体替换语义 → 保留全量）
  console.log("\n=== 运行中改写 patch（追加 hot-probe-0 / HotProbe）===");
  const modified = original.replace(
    `      bumen:`,
    `      hot-probe-0:
        displayName: HotProbe
        apiKeyEnv: LOBSTERAI_CUSTOM_0_API_KEY
        api: openai-completions
        baseURL: https://ai.jxbw.com/v1
        models:
          - id: Qwen3.8-Flash-AI
            name: Qwen3.8-Flash-AI
      bumen:`
  );
  if (modified === original) throw new Error("patch 替换失败：未找到锚点");
  fs.writeFileSync(PATCH, modified, "utf8");

  console.log("等待 HMR（awaitWriteFinish 2s + debounce + 处理余量）...");
  await sleep(3000); await sleep(6000);

  const s2 = await send("session/new", { cwd: CWD, mcpServers: [] });
  const after = parseModels(s2);
  summarize("② 改写后（新会话）", after);
  const afterHasGroup = after.groups.some((g) => /hot-probe-0/.test(g.group));

  // 闭环：用叶子 value 真实切换 + 发 prompt
  let switched = null, replied = null, replyText = null;
  if (afterHasGroup) {
    const leaf = after.flat.find((m) => /hot-probe-0/.test(m.value));
    console.log(`\n=== 闭环调用：source=${leaf.value}`);
    try {
      await send("session/set_config_option", { sessionId: sid, configId: "model", value: leaf.value });
      switched = "ok";
      const p = await send("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "只回复两个字：通了" }] });
      replied = p?.stopReason || "done";
      replyText = (updates || []).flatMap((u) => u.update ? [u.update] : [u])
        .filter((u) => u.sessionUpdate === "agent_message_chunk")
        .map((u) => u.content?.text || "").join("").slice(0, 120);
    } catch (e) { switched = "ERR: " + e.message.slice(0, 200); }
    console.log(`   set_config_option -> ${switched}`);
    console.log(`   prompt -> stopReason=${replied}  reply="${replyText}"`);
  }

  console.log("\n########## 判定 ##########");
  if (afterHasGroup && !baseHasGroup) {
    console.log("✅✅ HMR 热加载成立：运行中改文件 → provider 自动出现（4→" + base.groups.length + "→" + after.groups.length + " 组）");
    if (switched === "ok") console.log("✅✅ 且新 provider 可真实切换并调用成功 end_turn → 全链路闭环");
  } else if (afterHasGroup && baseHasGroup) {
    console.log("⚠️ 基线已含 hot-probe-0（上次未还原），本次不计");
  } else {
    console.log("❌ HMR 未生效");
    console.log("--- DSH stderr 尾部 ---\n" + stderrAll.split("\n").slice(-25).join("\n"));
  }
} catch (e) {
  console.log("✗ 异常:", e.message);
} finally {
  try { fs.writeFileSync(PATCH, original, "utf8"); console.log("\n[patch 已还原]"); } catch (e) { console.log("还原失败:", e.message); }
  try { child && child.kill(); } catch {}
  await sleep(800);
  process.exit(0);
}
