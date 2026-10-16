// 路线 C 真机端到端：BYOK → 合并写 patch → HMR 热加载 → provider 出现 + 可真实调用。
//
// 安全：全程走「备份 → 写入 → 验证 → **还原**」；用结束后 diff 校验还原一致。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as pp from "../src/profile-patch.mjs";

const NODE = "C:/Users/liuyue/.workbuddy/binaries/node/versions/22.22.2-2/node.exe";
const BIN = "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";
const PATCH = "C:/Users/liuyue/.dsh/profiles/acp/cordis.patch.yml";
const BYOK_FILE = "C:/Users/liuyue/AppData/Roaming/Code/User/chatLanguageModels.json";
const CWD = "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30/temp/dsh-ahp-bridge";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP_BAK = path.join(CWD, "..", `acp-patch.bak-routeC-${Date.now()}`);

const ORIGINAL = fs.readFileSync(PATCH, "utf8");
fs.writeFileSync(TMP_BAK, ORIGINAL, "utf8");

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
  if (x.method === "session/update" && x.params?.update?.sessionUpdate === "config_option_update") {
    const mo = (x.params.update.configOptions || []).find((o) => o.id === "model");
    cfgUpdates.push((mo?.options || []).map((g) => g.group ?? g.name));
  }
}
function groups(cfg) {
  const mo = (cfg?.configOptions || []).find((o) => o.id === "model");
  return (mo?.options || []).map((g) => ({ group: g.group ?? g.name, models: (g.options || []).map((v) => v.value) }));
}
function show(tag, gs) {
  console.log(`\n--- ${tag} (${gs.length} 组) ---`);
  for (const g of gs) console.log(`   [${g.group}] ${g.models.join(", ")}`);
}

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${e ? " | " + e : ""}`); } };

try {
  console.log("=== 0. 读 VS Code BYOK ===");
  const byok = JSON.parse(fs.readFileSync(BYOK_FILE, "utf8"));
  const provs = pp.byokToDshProviders(byok);
  console.log(`   BYOK 组: ${byok.map((b) => b.name).join(", ")}`);
  console.log(`   → DSH provider: ${provs.map((p) => p.key).join(", ")}`);

  console.log("\n=== 1. 启动 DSH acp（HMR 已启用）===");
  child = spawn(NODE, [BIN, "--profile", "acp"], { cwd: CWD, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); onLine(l); } });
  child.stderr.on("data", () => {});
  await send("initialize", { protocolVersion: 1, clientCapabilities: {} });

  const s1 = await send("session/new", { cwd: CWD, mcpServers: [] });
  const sid = s1.sessionId;
  const before = groups(s1);
  show("① 写入前", before);
  ok("写入前无 bowei/boweibm", !before.some((g) => /bowei/.test(g.group)));

  console.log("\n=== 2. 调 syncByokToDshPatch（真实写盘）===");
  const res = await pp.syncByokToDshPatch({ byok, profile: "acp" });
  console.log(`   patch=${res.patchPath}`);
  console.log(`   hmrEnabled=${res.hmrEnabled} changed=${res.changed} written=${res.written}`);
  console.log(`   added=[${res.added.join(", ")}] removed=[${res.removed.join(", ")}]`);
  if (res.backup) console.log(`   backup=${path.basename(res.backup)}`);
  ok("已写盘", res.written === true);
  ok("hmr 仍启用", res.hmrEnabled === true);
  const afterText = fs.readFileSync(PATCH, "utf8");
  ok("原生 provider 未丢失（lobsterai-custom-0 / bumen）",
    pp.extractProviderNames(afterText).includes("lobsterai-custom-0") && pp.extractProviderNames(afterText).includes("bumen"),
    JSON.stringify(pp.extractProviderNames(afterText)));
  ok("hmr 条目仍在文件里", pp.isHmrEnabled(afterText));

  console.log("\n=== 3. 等 HMR 热加载（3s+8s）===");
  await sleep(3000); await sleep(8000);

  const s2 = await send("session/new", { cwd: CWD, mcpServers: [] });
  const after = groups(s2);
  show("② 写入+HMR 后（新会话）", after);
  const hasBowei = after.some((g) => g.group === "bowei");
  const hasBoweiBM = after.some((g) => g.group === "boweibm");
  ok("bowei 已热加载出现", hasBowei);
  ok("boweibm 已热加载出现", hasBoweiBM);
  ok("原生 4 组仍在", ["deepseek-official", "deepseek-account", "lobsterai-custom-0", "bumen"].every((k) => after.some((g) => g.group === k)),
    after.map((g) => g.group).join(","));
  ok("收到 config_option_update 推送", cfgUpdates.length > 0, `count=${cfgUpdates.length}`);

  console.log("\n=== 4. 闭环调用新 provider（bowei / Qwen3.8-Flash-AI）===");
  const bowei = after.find((g) => g.group === "bowei");
  const leaf = bowei?.models.find((v) => /Qwen3.8-Flash-AI/.test(v)) ?? bowei?.models[0];
  console.log(`   source=${leaf}`);
  let switched = null, stop = null, text = null;
  try {
    await send("session/set_config_option", { sessionId: sid, configId: "model", value: leaf });
    switched = "ok";
    const p = await send("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "只回复两个字：通了" }] });
    stop = p?.stopReason;
  } catch (e) { switched = "ERR: " + e.message.slice(0, 160); }
  console.log(`   set_config_option -> ${switched}`);
  console.log(`   prompt -> stopReason=${stop}`);
  ok("新 provider 可切换", switched === "ok", switched);

  console.log("\n=== 5. 幂等复跑（内容不变 ⇒ 不应写盘）===");
  const res2 = await pp.syncByokToDshPatch({ byok, profile: "acp", managedKeys: provs.map((p) => p.key) });
  console.log(`   changed=${res2.changed} written=${res2.written}`);
  ok("第二次不写盘（幂等）", res2.written === false, `written=${res2.written}`);

  console.log("\n########## 端到端判定 ##########");
  console.log(`  ${pass} 通过 / ${fail} 失败`);
  if (fail === 0) console.log("  ✅✅ 全链路闭环：BYOK → 合并写 patch（保留原生）→ HMR 热加载 → 新 provider 出现并可调用");
} catch (e) {
  console.log("✗ 异常:", e.stack || e.message);
  fail++;
} finally {
  child?.kill();
  await sleep(900);
  // 还原
  fs.writeFileSync(PATCH, ORIGINAL, "utf8");
  const now = fs.readFileSync(PATCH, "utf8");
  console.log(`\n[还原] patch 与原始一致: ${now === ORIGINAL}`);
  console.log(`[备份] ${path.basename(TMP_BAK)}`);
  // 清理桥写入时产生的 .bowel-ahp-bak-* 与 .tmp-*
  for (const f of fs.readdirSync(path.dirname(PATCH))) {
    if (f.startsWith("cordis.patch.yml.bowel-ahp-bak-") || /^cordis\.patch\.yml\.tmp-/.test(f)) {
      try { fs.unlinkSync(path.join(path.dirname(PATCH), f)); console.log(`[清理] ${f}`); } catch {}
    }
  }
  process.exit(fail ? 1 : 0);
}
