// 提取指定方法体（只读）
import fs from "node:fs";
import { agentHostMainPath } from "./vscode-locate.mjs";
const B = process.env.AHP_BUNDLE || agentHostMainPath();
const s = fs.readFileSync(B, "utf8");

function matchBrace(str, openIdx) {
  let i = openIdx, depth = 0, mode = null;
  for (; i < str.length; i++) {
    const ch = str[i], nx = str[i + 1];
    if (mode) {
      if (ch === "\\") { i++; continue; }
      if (ch === mode) mode = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { mode = ch; continue; }
    if (ch === "/" && nx === "/") { const j = str.indexOf("\n", i); i = j === -1 ? str.length : j; continue; }
    if (ch === "/" && nx === "*") { const j = str.indexOf("*/", i); i = j === -1 ? str.length : j + 1; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const names = process.argv.slice(2);
const MAXLEN = Number(process.env.MAXLEN || 3000);
for (const name of names) {
  const pat = new RegExp("(?:^|[;,}\\s])(?:static\\s+|async\\s+|get\\s+|set\\s+|#)*" + name + "\\s*\\(", "g");
  let m, k = 0;
  while ((m = pat.exec(s))) {
    const open = s.indexOf("{", m.index + m[0].length - 1);
    if (open < 0) continue;
    const end = matchBrace(s, open);
    if (end < 0) continue;
    const len = end - open;
    if (len > MAXLEN) continue;
    console.log(`\n########## ${name} @ ${m.index} len=${len} ##########`);
    console.log(s.slice(m.index, end + 1).replace(/\n/g, " "));
    k++;
    if (k >= Number(process.env.N || 1)) break;
  }
  if (!k) console.log(`\n[not found] ${name}`);
}
