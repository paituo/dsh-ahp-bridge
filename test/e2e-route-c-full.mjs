// 路线 C 端到端（含凭据闭环）：
//   BYOK → 合并写 patch → HMR 热加载 → 出现新 provider
//        → 用真实凭据补全（复用已配的 jxbw key 作为演示值）→ 真实 prompt 成功
//        → 全程结束后**完全还原** patch 与 credentials（diff 校验）
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as pp from "../src/profile-patch.mjs";

const NODE = "C:/Users/liuyue/.workbuddy/binaries/node/versions/22.22.2-2/node.exe";
const BIN = "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";
const PATCH = "C:/Users/liuyue/.dsh/profiles/acp/cordis.patch.yml";
const CRED = "C:/Users/liuyue/.dsh/.credentials.yaml";
const BYOK_FILE = "C:/Users/liuyue/AppData/Roaming/Code/User/chatLanguageModels.json";
const CWD = "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30/temp/dsh-ahp-bridge";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ORIG_PATCH = fs.readFileSync(PATCH, "utf8");
const ORIG_CRED = fs.readFileSync(CRED, "utf8");
// 演示用真实 key：该 BYOK 组 baseURL=ai.jxbw.com，与已配的 LOBSTERAI_CUSTOM_0_API_KEY 同源
const DEMO_KEY = /LOBSTERAI_CUSTOM_0_API_KEY:\s*(\S+)/.exec(ORIG_CRED)?.[1];
if (!DEMO_KEY) throw new Error("找不到演示用 key");
const DEMO_REF = "BOWEI_AHP_BYOK_BOWEI_API_KEY";

let child, buf = "", id = 0;
const pending = new Map();
const cfgUpdates = [];
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
  if (x.method === "session/update" && x.params?.update?.sessionUpdate === "config_option_update") cfgUpdates.push(Date.now());
}
function groups(cfg) {
  const mo = (cfg?.configOptions || []).find((o) => o.id === "model");
  return (mo?.options || []).map((g) => ({ group: g.group ?? g.name, models: (g.options || []).map((v) => v.value) }));
}
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${e ? " | " + e : ""}`); } };

try {
  const byok = JSON.parse(fs.readFileSync(BYOK_FILE, "utf8"));
  const provs = pp.byokToDshProviders(byok);
  console.log("=== 0. BYOK → provider ===");
  for (const p of provs) console.log(`   ${p.key}: ${p.baseURL} | models=${p.models.map((m) => m.id).join(",")} | ref=${p.apiKeyEnv}`);
  const chk = await pp.checkCredentials(provs);
  console.log(`   凭据缺口: ${chk.missing.join(", ") || "(无)"}`);

  console.log("\n=== 1. 启动 DSH acp ===");
  child = spawn(NODE, [BIN, "--profile", "acp"], { cwd: CWD, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); onLine(l); } });
  child.stderr.on("data", () => {});
  await send("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const s1 = await send("session/new", { cwd: CWD, mcpServers: [] });
  const sid = s1.sessionId;
  ok("基线无 bowei", !groups(s1).some((g) => /bowei/.test(g.group)));

  console.log("\n=== 2. 写 patch（合并 BYOK provider）===");
  const r1 = await pp.syncByokToDshPatch({ byok, profile: "acp" });
  console.log(`   changed=${r1.changed} written=${r1.written} added=[${r1.added}]`);
  ok("已写盘", r1.written);
  ok("原生 provider 保留", ["lobsterai-custom-0", "bumen"].every((k) => pp.extractProviderNames(fs.readFileSync(PATCH, "utf8")).includes(k)));

  console.log("\n=== 3. 补凭据（演示：复用 jxbw key 写入 DEMO_REF）===");
  const rc = await pp.setCredentialRef(DEMO_REF, DEMO_KEY, {});
  console.log(`   ${DEMO_REF} -> written=${rc.written} existed=${rc.existed}`);
  ok("凭据已写入", rc.written);
  const after = await pp.listCredentialRefs({});
  ok("refs 里出现新条目", after.refs.includes(DEMO_REF), after.refs.join(","));
  ok("原有 refs 未丢", ["DEEPSEEK_API_KEY", "LOBSTERAI_CUSTOM_0_API_KEY", "BUMEN_API_KEY"].every((k) => after.refs.includes(k)));

  console.log("\n=== 4. 等 HMR 热加载（3s+8s）===");
  await sleep(3000); await sleep(8000);
  const s2 = await send("session/new", { cwd: CWD, mcpServers: [] });
  const gs = groups(s2);
  console.log(`   分组数=${gs.length}: ${gs.map((g) => g.group).join(", ")}`);
  ok("bowei 出现", gs.some((g) => g.group === "bowei"));
  ok("boweibm 出现", gs.some((g) => g.group === "boweibm"));
  ok("原生 4 组仍在", ["deepseek-official", "deepseek-account", "lobsterai-custom-0", "bumen"].every((k) => gs.some((g) => g.group === k)));
  ok("收到推送", cfgUpdates.length > 0, `count=${cfgUpdates.length}`);

  console.log("\n=== 5. 闭环：切到 bowei 并真实调用 ===");
  const leaf = gs.find((g) => g.group === "bowei")?.models[0];
  console.log(`   source=${leaf}`);
  let stop = null, err = null, reply = "";
  try {
    await send("session/set_config_option", { sessionId: sid, configId: "model", value: leaf });
    const p = await send("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "只回复两个字：通了" }] });
    stop = p?.stopReason;
  } catch (e) { err = e.message.slice(0, 200); }
  console.log(`   prompt -> stopReason=${stop} err=${err ?? "none"}`);
  ok("新 provider 真实调用成功", stop === "end_turn", err ?? "");

  console.log("\n=== 6. 幂等复跑 ===");
  const r2 = await pp.syncByokToDshPatch({ byok, profile: "acp", managedKeys: provs.map((p) => p.key) });
  ok("第二次不写盘", r2.written === false);
  const rc2 = await pp.setCredentialRef(DEMO_REF, DEMO_KEY, {});
  ok("凭据写入幂等", rc2.written === false);

  console.log("\n########## 端到端判定 ##########");
  console.log(`  ${pass} 通过 / ${fail} 失败`);
  if (fail === 0) console.log("  ✅✅✅ 全链路闭环：BYOK → 合并写 patch（保留原生）→ HMR 热加载 → 补凭据 → 真实调用 end_turn");
} catch (e) {
  console.log("✗ 异常:", e.stack || e.message); fail++;
} finally {
  child?.kill(); await sleep(900);
  fs.writeFileSync(PATCH, ORIG_PATCH, "utf8");
  fs.writeFileSync(CRED, ORIG_CRED, "utf8");
  console.log(`\n[还原] patch 一致=${fs.readFileSync(PATCH, "utf8") === ORIG_PATCH}  credentials 一致=${fs.readFileSync(CRED, "utf8") === ORIG_CRED}`);
  for (const dir of [path.dirname(PATCH), path.dirname(CRED)]) {
    for (const f of fs.readdirSync(dir)) {
      if (/\.(bowel-ahp-bak-|tmp-)/.test(f)) { try { fs.unlinkSync(path.join(dir, f)); console.log(`[清理] ${f}`); } catch {} }
    }
  }
  process.exit(fail ? 1 : 0);
}
