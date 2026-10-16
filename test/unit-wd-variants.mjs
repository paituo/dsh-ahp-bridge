// 离线单测：resolveSessionWorkingDir + expandChatUriVariants（P0-1 修复验证）
import { resolveSessionWorkingDir, expandChatUriVariants } from "../src/inject-snippet.mjs";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  const mark = ok ? "[PASS]" : "[FAIL]";
  console.log(mark + " " + name);
  console.log("     got=" + JSON.stringify(got) + (ok ? "" : "  want=" + JSON.stringify(want)));
  ok ? pass++ : fail++;
};

const meta = { "dsh:/39e48894-0175-4c80-9116-1b8fbc462ac3": { workingDirectories: [{ fsPath: "D:/GoProjects/bowei-agent-work" }] } };
const getSS = (uri) => meta[uri];

// 1) 原始形态（ahp-chat://）应通过解码命中
eq("decode->hit (ahp-chat://default/b64)",
  resolveSessionWorkingDir(
    { configurationResource: "ahp-chat://default/" + Buffer.from("dsh:/39e48894-0175-4c80-9116-1b8fbc462ac3").toString("base64url") },
    getSS),
  "D:/GoProjects/bowei-agent-work");

// 2) 直查形态（dsh:/uuid）仍工作（零回归）
eq("direct dsh:/uuid still works",
  resolveSessionWorkingDir({ configurationResource: "dsh:/39e48894-0175-4c80-9116-1b8fbc462ac3" }, getSS),
  "D:/GoProjects/bowei-agent-work");

// 3) 变体展开
eq("expandChatUriVariants decodes base64url",
  expandChatUriVariants("ahp-chat://default/" + Buffer.from("dsh:/abc").toString("base64url")),
  ["dsh:/abc"]);

// 4) 非 base64 payload 不产生垃圾变体
eq("non-base64 payload -> no variant", expandChatUriVariants("ahp-chat://default/not!base64"), []);

// 5) 已知 URI 但无 workingDirectories -> undefined（不误判）
eq("known uri w/o wd -> undefined",
  resolveSessionWorkingDir({ configurationResource: "dsh:/39e48894-0175-4c80-9116-1b8fbc462ac3" }, () => ({})),
  undefined);

// 6) 无 ctx -> undefined（健壮性）
eq("null ctx -> undefined", resolveSessionWorkingDir(null, getSS), undefined);

console.log("\n=== " + pass + " pass / " + fail + " fail ===");
process.exit(fail ? 1 : 0);
