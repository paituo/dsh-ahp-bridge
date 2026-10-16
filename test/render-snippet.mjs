import { P3_TT_SHELL_REROUTE_SNIPPET, readMessageText } from "../src/inject-snippet.mjs";
import fs from "node:fs";
let s = P3_TT_SHELL_REROUTE_SNIPPET
  .replace(/__SPAWN_NS__/g, "R0")
  .replace(/__BRIDGE__/g, "C:/x/bridge.mjs")
  .replace(/__DSH_BIN__/g, "C:/x/bin.js")
  .replace(/__NODE__/g, "C:/x/node.exe")
  .replace(/__CWD__/g, "C:/x")
  .replace(/__READ_TEXT__/g, readMessageText.toString());
fs.writeFileSync(new URL("./rendered-snippet.js", import.meta.url), s);
console.log("rendered bytes:", s.length);
console.log("has reset-on-exit:", s.includes("resetting channel"));
console.log("has refreshModels x2:", (s.match(/setTimeout\(refreshModels/g) || []).length);
