// 单元测试：resolveSessionWorkingDir / uriLikeToFsPath（遗留项4 核心逻辑）
// 契约（源码实证）：
//   - VS Code state.workingDirectories 元素是**字符串**（sessions: M.parse(bo)），
//     典型值 file:///C:/repo/wt1；workingDirectory(单数) 不是 state 字段。
//   - uriLikeToFsPath 只负责「URI-ish → 路径」；**裸 Windows 路径原样返回**（不归一）。
import { resolveSessionWorkingDir, uriLikeToFsPath } from "../src/inject-snippet.mjs";

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("  FAIL " + name + "\n       got=" + JSON.stringify(got) + "\n       want=" + JSON.stringify(want)); }
};

console.log("[uriLikeToFsPath]");
t("file:/// 盘符", uriLikeToFsPath("file:///c%3A/Users/x/repo"), "c:/Users/x/repo");
t("file:// 带盘符前缀", uriLikeToFsPath("file:///C:/a/b"), "C:/a/b");
t("纯路径原样(契约)", uriLikeToFsPath("C:/a/b"), "C:/a/b");
t("裸反斜杠原样(契约)", uriLikeToFsPath("C:\a\b"), "C:\a\b");
t("unc file://(契约:只取 path)", uriLikeToFsPath("file://server/share/x"), "/share/x");
t("解码 %20", uriLikeToFsPath("file:///C:/a%20b/c"), "C:/a b/c");
t("URI 对象 .fsPath 优先", uriLikeToFsPath({ fsPath: "C:/x/y", toString: () => "file:///C:/zzz" }), "C:/x/y");
t("URI 对象 .path 回落", uriLikeToFsPath({ path: "/C:/x/y" }), "/C:/x/y");
t("null → undefined", uriLikeToFsPath(null), undefined);
t("空串 → undefined", uriLikeToFsPath("   "), undefined);

console.log("[resolveSessionWorkingDir]");
{
  const calls = [];
  const getSS = (u) => { calls.push(u); return { workingDirectories: ["file:///C:/repo/wt1"] }; };
  t("stateManager 命中(数组 str)", resolveSessionWorkingDir({ configurationResource: "vscode-agent-host://sess1" }, getSS), "C:/repo/wt1");
  t("  → 用 configurationResource 查询", calls[0], "vscode-agent-host://sess1");
}
{
  const getSS = () => ({ workingDirectories: [{ fsPath: "C:/repo/wt2" }] });
  t("stateManager 命中(URI 对象)", resolveSessionWorkingDir({ resource: "sess2" }, getSS), "C:/repo/wt2");
}
{
  const getSS = () => { throw new Error("boom"); };
  t("stateManager 抛错 → undefined", resolveSessionWorkingDir({ configurationResource: "s" }, getSS), undefined);
}
t("无 getSS → undefined", resolveSessionWorkingDir({ configurationResource: "s" }, undefined), undefined);
t("空 ctx → undefined", resolveSessionWorkingDir({}, () => undefined), undefined);
t("null ctx → undefined", resolveSessionWorkingDir(null, () => undefined), undefined);
t("空数组 → undefined（不误取）", resolveSessionWorkingDir({ configurationResource: "s" }, () => ({ workingDirectories: [] })), undefined);
{
  const getSS = () => ({ workingDirectories: ["file:///C:/r/a", "file:///C:/r/b"] });
  t("多目录取首个", resolveSessionWorkingDir({ configurationResource: "s" }, getSS), "C:/r/a");
}
{
  const calls = [];
  const getSS = (u) => { calls.push(u); return undefined; };
  resolveSessionWorkingDir({ resource: "sess-from-resource" }, getSS);
  t("无 configurationResource 时用 resource", calls[0], "sess-from-resource");
}
{
  // 首个不可解析、次个可解析 → 取次个
  const getSS = () => ({ workingDirectories: ["", "file:///C:/repo/second"] });
  t("跳过空元素取次个", resolveSessionWorkingDir({ configurationResource: "s" }, getSS), "C:/repo/second");
}

console.log("\n结果: " + pass + " pass, " + fail + " fail");
process.exit(fail ? 1 : 0);
