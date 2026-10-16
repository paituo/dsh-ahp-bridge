// audit-dsh-modes-presets.mjs — 取证：DSH acp profile 的 session/new 回执里
// 是否有 modes(availableModes) / configOptions / _meta 承载 agent preset 的痕迹。
// 说明：本探针使用 DshAcpClient（原生 ACP，不经 AHP 桥），拿到的是 ACP 层的原始回执。
import { DshAcpClient } from "../src/dsh-acp-client.mjs";

const DSH_BIN = process.argv[2] || "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";
const CWD = process.argv[3] || "D:/GoProjects/bowei-agent-work";

const dump = (o, n = 3000) => JSON.stringify(o, null, 2)?.slice(0, n);

(async () => {
  const dsh = new DshAcpClient({
    dshBinPath: DSH_BIN,
    nodePath: process.execPath,
    cwd: CWD,
    log: (lvl, msg) => { if (lvl !== "debug") console.log(`[dsh:${lvl}] ${msg}`); },
  });
  await dsh.start();
  const initRes = await dsh.initialize(
    { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    { name: "audit-client", version: "0.1.0" },
  );
  console.log("=== initialize 回执 ===");
  console.log("agentCapabilities:", dump(initRes?.agentCapabilities, 1500));
  console.log("agentInfo:", dump(initRes?.agentInfo, 800));
  console.log("protocolVersion:", initRes?.protocolVersion);

  const res = await dsh.newSession({ cwd: CWD, mcpServers: [] });
  console.log("\n=== session/new 回执顶层 keys ===", Object.keys(res));

  // ★ 关键点 1：modes（ACP 原生模式槽位）
  console.log("\n=== ★ modes (SessionModeState) ===");
  console.log(dump(res.modes, 2500) || "(undefined)");

  // ★ 关键点 2：configOptions（ACP 配置槽位，category 可为 mode/model/...）
  const co = res.configOptions;
  console.log("\n=== ★ configOptions 全量 ===");
  console.log(dump(co, 3500) || "(undefined)");
  if (Array.isArray(co)) {
    console.log("\n--- configOptions 摘要 ---");
    for (const o of co) {
      const vals = o.options ?? o.values ?? [];
      const cnt = Array.isArray(vals) ? vals.length : Object.keys(vals || {}).length;
      console.log(`  id=${o.id} category=${o.category ?? "(none)"} type=${o.type} opts=${cnt} current=${JSON.stringify(o.currentValue ?? o.currentValueId)?.slice(0, 60)}`);
    }
    const nonModel = co.filter((o) => o.category !== "model" && o.id !== "model");
    console.log("\n=== 非 model 的 configOption（潜在 agent/preset 承载）===");
    console.log(dump(nonModel, 2500) || "(none)");
  }

  // ★ 关键点 3：_meta 里是否有 preset/agent 痕迹
  console.log("\n=== ★ _meta ===");
  console.log(dump(res._meta, 2500) || "(undefined)");

  // ★ 关键点 4：全回执兜底搜 preset / agent / liangshen 关键词
  const flat = JSON.stringify(res);
  console.log("\n=== 关键词命中 ===");
  for (const w of ["preset", "agent", "liangshen", "梁神", "mode", "0x"]) {
    const i = flat.toLowerCase().indexOf(w.toLowerCase());
    console.log(`  "${w}": ${i < 0 ? "(miss)" : flat.slice(Math.max(0, i - 60), i + 90)}`);
  }

  await dsh.stop?.();
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
