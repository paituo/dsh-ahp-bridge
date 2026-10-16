// 只列类结构（字段+方法签名），不 dump 正文
import fs from "node:fs";
import { agentHostMainPath } from "./vscode-locate.mjs";
const B = process.env.AHP_BUNDLE || agentHostMainPath();
const s = fs.readFileSync(B, "utf8");

function matchBrace(str, o) {
  let i = o, d = 0, m = null;
  for (; i < str.length; i++) {
    const c = str[i], x = str[i + 1];
    if (m) { if (c === "\\") { i++; continue; } if (c === m) m = null; continue; }
    if (c === '"' || c === "'" || c === "`") { m = c; continue; }
    if (c === "/" && x === "/") { const j = str.indexOf("\n", i); i = j === -1 ? str.length : j; continue; }
    if (c === "/" && x === "*") { const j = str.indexOf("*/", i); i = j === -1 ? str.length : j + 1; continue; }
    if (c === "{") d++; else if (c === "}") { d--; if (d === 0) return i; }
  }
  return -1;
}

for (const nm of process.argv.slice(2)) {
  const re = new RegExp("(?:var\\s+)?" + nm + "\\s*=\\s*class", "g");
  let hit = null, m;
  while ((m = re.exec(s))) { hit = m.index; break; }
  if (hit == null) { console.log(`[${nm}] not a class= form`); continue; }
  const open = s.indexOf("{", hit);
  const end = matchBrace(s, open);
  const body = s.slice(open, end);
  const ext = (s.slice(hit, open).match(/extends\s+([A-Za-z_$][\w$]*)/) || [])[1] || "-";
  const fields = [...new Set([...body.matchAll(/this\.([A-Za-z_$][\w$]*)\s*=/g)].map(x => x[1]))];
  const methods = [...body.matchAll(/(?:^|[;,}\s])(?:static\s+|async\s+|get\s+|set\s+|#)*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g)];
  console.log(`\n===== ${nm} extends ${ext} @${hit} size=${end - open} =====`);
  console.log(`fields(${fields.length}): ${fields.join(", ")}`);
  console.log(`methods(${methods.length}):`);
  methods.forEach(x => console.log(`   ${x[1]}(${x[2].slice(0, 60)})`));
}
