// 用桥自己的 DSH ACP 客户端取证：session/new 回执的 configOptions 全集
import { DshAcpClient } from "../src/dsh-acp-client.mjs";

const DSH_BIN = process.argv[2] || "D:/JavaSofewares/npm-cache/dsh";
const CWD = process.argv[3] || "D:/GoProjects/bowei-agent-work";

(async () => {
  const dsh = new DshAcpClient({
    dshBinPath: DSH_BIN,
    nodePath: process.execPath,
    cwd: CWD,
    log: (lvl, msg) => { if (lvl !== "debug") console.log(`[dsh:${lvl}] ${msg}`); },
  });
  await dsh.start();
  await dsh.initialize(
    { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    { name: "audit-client", version: "0.1.0" },
  );
  console.log("initialize ok");

  const res = await dsh.newSession({ cwd: CWD, mcpServers: [] });
  console.log("\n=== session/new 回执 keys:", Object.keys(res));
  console.log("sessionId:", res.sessionId);

  const co = res.configOptions;
  console.log("\n=== configOptions 全量（截断 4000）===");
  console.log(JSON.stringify(co, null, 2).slice(0, 4000));

  if (Array.isArray(co)) {
    console.log("\n=== 各 option 摘要 ===");
    for (const o of co) {
      const vals = o.options ?? o.values ?? [];
      const cnt = Array.isArray(vals) ? vals.length : Object.keys(vals || {}).length;
      console.log(`  id=${o.id}  category=${o.category ?? "(none)"}  type=${o.type}  选项数=${cnt}  currentValue=${JSON.stringify(o.currentValue)?.slice(0,60)}`);
    }
    const nonModel = co.filter((o) => o.category !== "model" && o.id !== "model");
    console.log("\n=== ★ 非 model 的 configOption（可能承载 agent/preset/模式）===");
    console.log(JSON.stringify(nonModel, null, 2).slice(0, 3000));
  }

  await dsh.stop?.();
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
