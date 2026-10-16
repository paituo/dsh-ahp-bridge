// 实测：preset 发现模块（路线 B）
import { discoverPresets } from "../src/presets.mjs";

const DSH_INSTALL = "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh";

const res = await discoverPresets({
  dshInstallDir: DSH_INSTALL,
  profileName: "acp",
  includeLegacy: true,
});

console.log("=== counts ===", JSON.stringify(res.counts));
console.log("=== sources ===", JSON.stringify(res.sources));
console.log("=== presets (" + res.presets.length + ") ===");
for (const p of res.presets) {
  console.log(`  [${String(p.order).padStart(3)}] id=${p.id.padEnd(14)} name="${p.name}" src=${p.source}${p.legacy ? " (LEGACY)" : ""}`);
}
