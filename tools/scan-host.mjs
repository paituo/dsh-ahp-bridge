// 参照 HOST 整体实现扫描器（只读分析，不改 bundle）
// 用法: node tools/scan-host.mjs [section]
//   section: map | class:<name> | method:<name> | str:<literal> | all
import fs from "node:fs";
import { agentHostMainPath } from "./vscode-locate.mjs";

const BUNDLE = process.env.AHP_BUNDLE || agentHostMainPath();

const src = fs.readFileSync(BUNDLE, "utf8");
const log = (...a) => console.log(...a);

// 粗略括号配平，从 openIdx 的 '{' 找到匹配 '}'
function matchBrace(s, openIdx) {
  let i = openIdx, depth = 0, mode = null;
  for (; i < s.length; i++) {
    const ch = s[i], nx = s[i + 1];
    if (mode) {
      if (ch === "\\") { i++; continue; }
      if (ch === mode) mode = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { mode = ch; continue; }
    if (ch === "/" && nx === "/") { const j = s.indexOf("\n", i); i = j === -1 ? s.length : j; continue; }
    if (ch === "/" && nx === "*") { const j = s.indexOf("*/", i); i = j === -1 ? s.length : j + 1; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function listClasses() {
  const out = [];
  const re = /class\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([A-Za-z_$][\w$]*))?\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf("{", m.index);
    const end = matchBrace(src, open);
    out.push({ name: m[1], ext: m[2] || "", start: m.index, open, end, size: end - m.index });
  }
  return out;
}

function methodsOf(cls) {
  const body = src.slice(cls.open, cls.end);
  const out = [];
  // 方法定义: name(args){  或 static name(args){ 或 #name(args){ 或 get name(){ 或 async name(args){
  const re = /(?:^|[;,}\s])(?:static\s+|async\s+|get\s+|set\s+|#)*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g;
  let m;
  while ((m = re.exec(body))) {
    const abs = cls.open + m.index;
    out.push({ name: m[1], args: m[2].slice(0, 80), at: m.index, abs });
  }
  // 字段: this.name = 
  const reF = /this\.([A-Za-z_$][\w$]*)\s*=/g;
  const fields = new Set();
  while ((m = reF.exec(body))) fields.add(m[1]);
  return { out, fields: [...fields] };
}

const cmd = process.argv[2] || "map";

if (cmd === "map") {
  const cls = listClasses().sort((a, b) => a.start - b.start);
  log(`bundle size=${src.length}  classes=${cls.length}`);
  log("idx  name                          ext            start      size");
  cls.forEach((c, i) => {
    log(`${String(i).padStart(3)}  ${c.name.padEnd(28)}  ${(c.ext || "-").padEnd(13)}  ${String(c.start).padStart(9)}  ${c.size}`);
  });
} else if (cmd.startsWith("class:")) {
  const n = cmd.slice(6);
  const cls = listClasses().find(c => c.name === n);
  if (!cls) { log("not found:", n); process.exit(1); }
  const { out, fields } = methodsOf(cls);
  log(`class ${cls.name} extends ${cls.ext || "-"}  @${cls.start}..${cls.end} (${cls.size})`);
  log(`\n-- fields (${fields.length}) --`);
  log(fields.join(", "));
  log(`\n-- methods (${out.length}) --`);
  out.forEach(m => log(`  @${m.abs}  ${m.name}(${m.args})`));
} else if (cmd.startsWith("method:")) {
  const n = cmd.slice(7);
  const re = new RegExp(`(?:^|[;,}\\s])(?:static\\s+|async\\s+|get\\s+|set\\s+|#)*${n}\\s*\\([^)]*\\)\\s*\\{`, "g");
  let m, cnt = 0;
  while ((m = re.exec(src))) {
    const open = src.indexOf("{", m.index + m[0].length - 1);
    const end = matchBrace(src, open);
    log(`\n### ${n} @${m.index} (len ${end - open}) ###`);
    log(src.slice(m.index, Math.min(end + 1, m.index + 2400)).replace(/\n/g, " "));
    cnt++;
    if (cnt > 8) break;
  }
  if (!cnt) log("not found:", n);
} else if (cmd.startsWith("str:")) {
  const lit = cmd.slice(4);
  const idx = [...src.matchAll(new RegExp(lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))].map(m => m.index);
  log(`"${lit}" occurrences: ${idx.length}`);
  idx.slice(0, 12).forEach(i => log(`  @${i}  ${src.slice(Math.max(0, i - 180), i + 220).replace(/\n/g, " ")}`));
}
