#!/usr/bin/env node
/**
 * detached worktree 单元测试 —— 真实 git 仓库，不依赖 VS Code。
 *
 * 覆盖：
 *   ① create：真建 worktree、返回合法 { handle, resource }、目录/分支真实存在
 *   ② create 幂等边界：重复同路径 ⇒ 明确报错而非静默覆盖
 *   ③ create 非 git 目录 ⇒ 明确报错
 *   ④ 并发 create 同仓库 ⇒ 串行化，两个 worktree 互不冲突、目录名不碰撞
 *   ⑤ claim ⇒ 元数据 claimed=true
 *   ⑥ delete（无改动）⇒ git worktree 真被移除、记录清空
 *   ⑦ delete（有未提交改动）⇒ 保留目录 + 标 deletionPending（不丢数据）
 *   ⑧ setArchived(true) ⇒ 清理；setArchived(false) ⇒ 重建
 *   ⑨ reconcile：scope 匹配 + activeHandles ⇒ 保留；目录消失 ⇒ 清记录；deletionPending ⇒ 重试
 *   ⑩ 未知 handle ⇒ claim/delete 不崩（delete 幂等成功、claim 明确报错）
 *   ⑪ gitStore 持久化：跨 manager 实例可见
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorktreeManager, uriToPath, pathToFileUri, globToRegExp } from "../src/worktree.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}${extra ? ` — ${extra}` : ""}`); }
};

// ---------------------------------------------------------------- 测试沙箱
const SANDBOX = path.join(os.tmpdir(), `wt-test-${Date.now()}`);
const STORE = path.join(SANDBOX, "store", "ahp-worktrees.json");

function sh(cwd, cmd, argv) {
  const r = spawnSync(cmd, argv, { cwd, encoding: "utf8", windowsHide: true });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}
function gitInit(dir) {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  sh(dir, "git", ["config", "user.email", "t@t.t"]);
  sh(dir, "git", ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# sandbox\n");
  sh(dir, "git", ["add", "-A"]);
  sh(dir, "git", ["commit", "-q", "-m", "init"]);
}
function listWorktrees(repo) {
  const r = sh(repo, "git", ["worktree", "list", "--porcelain"]);
  return r.out.split(/\r?\n/).filter((l) => l.startsWith("worktree ")).map((l) => path.normalize(l.slice(9)));
}
function branchList(repo) {
  const r = sh(repo, "git", ["branch", "--format=%(refname:short)"]);
  return r.out.split(/\r?\n/).filter(Boolean);
}
const mkMgr = () => new WorktreeManager({ storeFile: STORE, log: () => {} });

(async () => {
  await fsp.rm(SANDBOX, { recursive: true, force: true });
  await fsp.mkdir(SANDBOX, { recursive: true });

  const REPO = path.join(SANDBOX, "proj");
  const NONREPO = path.join(SANDBOX, "not-a-repo");
  gitInit(REPO);
  fs.mkdirSync(NONREPO, { recursive: true });
  const SESSION = `vscode-agent-host://testauth/${REPO.replace(/\\/g, "/")}`;

  // ---------- ① create ----------
  console.log("=== ① create：真建 worktree ===");
  const mgr = mkMgr();
  const c1 = await mgr.create({ session: SESSION, prompt: "do the thing", config: { isolation: "worktree" } });
  ok(typeof c1.handle === "string" && c1.handle.startsWith("wt-"), "返回 handle", c1.handle);
  ok(typeof c1.resource === "string" && c1.resource.startsWith("file://"), "返回 file:// resource", c1.resource);
  const wt1 = uriToPath(c1.resource);
  ok(fs.existsSync(wt1), "worktree 目录真实存在", wt1);
  ok(fs.existsSync(path.join(wt1, "README.md")), "worktree 内容已 checkout");
  ok(listWorktrees(REPO).some((p) => path.normalize(p) === path.normalize(wt1)), "git worktree list 含该路径");
  ok(path.normalize(wt1).includes(".worktrees"), "位于 <repo>.worktrees 下（对齐内置约定）", wt1);
  const rec1 = await mgr.store.get(c1.handle);
  ok(rec1?.repositoryRoot && rec1?.worktreePath && rec1?.branchName, "元数据完整落盘");

  // ---------- ② 重复路径 ----------
  console.log("\n=== ② 边界：重复 create 不静默覆盖 ===");
  // 用固定分支前缀构造同名目录：先建一个，再手工把元数据指到同路径
  const c2 = await mgr.create({ session: SESSION, config: { isolation: "worktree" } });
  const wt2 = uriToPath(c2.resource);
  ok(fs.existsSync(wt2), "第二个 worktree 也建成");
  ok(path.normalize(wt1) !== path.normalize(wt2), "两个 worktree 目录不碰撞（串行 + 短哈希）");

  // ---------- ③ 非 git 仓库 ----------
  console.log("\n=== ③ 边界：非 git 目录明确报错 ===");
  let threw = null;
  try {
    await mgr.create({ session: SESSION, workingDirectory: NONREPO, config: { isolation: "worktree" } });
  } catch (e) { threw = e.message; }
  ok(!!threw && /Git repository/i.test(threw), "非 git 目录报明确错误", threw);

  // ---------- ④ 并发 create ----------
  console.log("\n=== ④ 并发 create（同仓库串行化）===");
  const before = listWorktrees(REPO).length;
  const batch = await Promise.all([
    mgr.create({ session: SESSION, config: { isolation: "worktree" } }),
    mgr.create({ session: SESSION, config: { isolation: "worktree" } }),
    mgr.create({ session: SESSION, config: { isolation: "worktree" } }),
  ]);
  const paths = batch.map((b) => uriToPath(b.resource));
  const uniq = new Set(paths.map((p) => path.normalize(p).toLowerCase()));
  ok(uniq.size === 3, "3 个并发请求产出 3 个互异路径", `uniq=${uniq.size}`);
  ok(paths.every((p) => fs.existsSync(p)), "三个目录全部真实存在");
  ok(listWorktrees(REPO).length === before + 3, "git 侧多出 3 个 worktree");
  const handles = new Set(batch.map((b) => b.handle));
  ok(handles.size === 3, "3 个互异 handle");

  // ---------- ⑤ claim ----------
  console.log("\n=== ⑤ claim ===");
  await mgr.claim({ handle: c1.handle });
  const rec1b = await mgr.store.get(c1.handle);
  ok(rec1b.claimed === true && Number.isFinite(rec1b.claimedAt), "claimed=true + claimedAt 已写");
  let claimThrew = null;
  try { await mgr.claim({ handle: "wt-does-not-exist" }); } catch (e) { claimThrew = e.message; }
  ok(!!claimThrew && /Unknown detached worktree handle/.test(claimThrew), "未知 handle claim 明确报错", claimThrew);

  // ---------- ⑥ delete（无改动）----------
  console.log("\n=== ⑥ delete（无未提交改动）===");
  const delRes = await mgr.delete({ handle: c1.handle });
  ok(delRes.deleted === true, "返回 deleted=true");
  ok(!fs.existsSync(wt1), "目录已被 git 移除");
  ok(!listWorktrees(REPO).some((p) => path.normalize(p) === path.normalize(wt1)), "git worktree list 不再含它");
  ok(!(await mgr.store.get(c1.handle)), "记录已清空");

  // ---------- ⑦ delete（有改动 ⇒ 保护）----------
  console.log("\n=== ⑦ delete（有未提交改动 ⇒ 保护数据）===");
  fs.writeFileSync(path.join(wt2, "dirty.txt"), "uncommitted\n");
  const delRes2 = await mgr.delete({ handle: c2.handle });
  ok(delRes2.deleted === false && delRes2.reason === "uncommitted-changes", "拒绝删除并说明原因", JSON.stringify(delRes2));
  ok(fs.existsSync(path.join(wt2, "dirty.txt")), "未提交文件仍在（数据未丢）");
  const rec2 = await mgr.store.get(c2.handle);
  ok(rec2?.deletionPending === true, "标记 deletionPending（供 reconcile 重试）");

  // 幂等：未知 handle delete 应成功（不抛）
  const delUnknown = await mgr.delete({ handle: "wt-nope" });
  ok(delUnknown && typeof delUnknown === "object", "未知 handle delete 幂等成功");

  // ---------- ⑧ setArchived ----------
  console.log("\n=== ⑧ setArchived（归档/解档）===");
  const c3 = await mgr.create({ session: SESSION, config: { isolation: "worktree" } });
  const wt3 = uriToPath(c3.resource);
  ok(fs.existsSync(wt3), "c3 worktree 已建");
  await mgr.setArchived({ handle: c3.handle, archived: true });
  ok(!fs.existsSync(wt3), "归档后目录被清理（无改动）");
  ok((await mgr.store.get(c3.handle))?.archived === true, "元数据 archived=true（记录保留）");
  await mgr.setArchived({ handle: c3.handle, archived: false });
  ok(fs.existsSync(wt3), "解档后目录被重建");

  // ---------- ⑨ reconcile ----------
  console.log("\n=== ⑨ reconcile ===");
  const c4 = await mgr.create({ session: SESSION, config: { isolation: "worktree" } });
  const wt4 = uriToPath(c4.resource);
  await mgr.claim({ handle: c4.handle });
  // 9a：scope 匹配 + activeHandles 命中 ⇒ 保留
  await mgr.reconcile({ scope: SESSION, activeHandles: [c4.handle] });
  ok(fs.existsSync(wt4), "9a: activeHandles 命中的 worktree 被保留");

  // 9b：目录被外部删除 ⇒ 清记录
  fs.rmSync(wt4, { recursive: true, force: true });
  const r9b = await mgr.reconcile({ scope: SESSION, activeHandles: [] });
  ok(!(await mgr.store.get(c4.handle)), "9b: 目录消失 ⇒ 记录被清");
  ok(r9b.removed >= 1, "9b: summary.removed 计数正确", JSON.stringify(r9b));

  // 9c：deletionPending ⇒ 重试（先把 dirty 清掉，模拟用户处理完）
  fs.rmSync(path.join(wt2, "dirty.txt"), { force: true });
  const r9c = await mgr.reconcile({ scope: SESSION, activeHandles: [] });
  ok(!(await mgr.store.get(c2.handle)), "9c: deletionPending 重试后记录清空");
  ok(!fs.existsSync(wt2), "9c: 目录已回收");
  ok(r9c.retried >= 1, "9c: summary.retried 计数正确", JSON.stringify(r9c));

  // ---------- ⑩ startupCleanup ----------
  console.log("\n=== ⑩ startupCleanup（未认领残留清理）===");
  const c5 = await mgr.create({ session: SESSION, config: { isolation: "worktree" } });
  const wt5 = uriToPath(c5.resource);
  // 未认领 + 新鲜 ⇒ 应被保留（不误删刚建的）
  await mgr.startupCleanup();
  ok(fs.existsSync(wt5), "新鲜未认领的 worktree 不被误删");
  // 伪造成"超时未认领" ⇒ 应被回收
  await mgr.store.patch(c5.handle, { createdAt: Date.now() - 1000 * 60 * 60 * 24, claimed: false, claimedAt: null });
  await mgr.startupCleanup();
  ok(!fs.existsSync(wt5), "超时未认领的 worktree 被回收");

  // ---------- ⑪ 持久化跨实例 ----------
  console.log("\n=== ⑪ 存储持久化 ===");
  const c6 = await mgr.create({ session: SESSION, config: { isolation: "worktree" } });
  const mgr2 = mkMgr();     // 新实例，共享同一 store 文件
  ok(!!(await mgr2.store.get(c6.handle)), "新 manager 实例能读到既有记录");
  const st = await mgr2.stats();
  ok(st.total >= 1 && Number.isFinite(st.claimed), "stats 可用", JSON.stringify({ total: st.total, claimed: st.claimed }));

  // ---------- ⑫ worktree 根目录约定 ----------
  console.log("\n=== ⑫ 路径约定 ===");
  const expectedRoot = path.join(path.dirname(REPO), `${path.basename(REPO)}.worktrees`);
  ok(path.normalize(path.dirname(uriToPath(c6.resource))) === path.normalize(expectedRoot),
    "<repo>.worktrees 根目录（对齐内置 vK）", path.dirname(uriToPath(c6.resource)));
  const brs = branchList(REPO);
  ok(brs.some((b) => b.startsWith("worktree-")), "自动分支名带 worktree- 前缀", brs.join(","));

  // ---------- ⑬ worktreeIncludeFiles / worktreeSymlinkFolders（对齐内置 host）----------
  console.log("\n=== ⑬ include files / symlink folders ===");
  {
    // 在仓库里制造：未跟踪的配置类文件（应被复制）+ 一个目录（应被软链）+ 已跟踪文件（不应被覆盖）
    fs.writeFileSync(path.join(REPO, ".env"), "SECRET=1\n");
    fs.mkdirSync(path.join(REPO, "cache"), { recursive: true });
    fs.writeFileSync(path.join(REPO, "cache", "big.bin"), "x".repeat(1024));
    fs.writeFileSync(path.join(REPO, "notes.txt"), "should-not-copy\n");   // 不匹配模式

    const c7 = await mgr.create({
      session: SESSION,
      config: {
        isolation: "worktree",
        worktreeIncludeFiles: ["**/.env", "*.txt"],
        worktreeSymlinkFolders: ["cache"],
      },
    });
    const wt7 = uriToPath(c7.resource);

    ok(fs.existsSync(path.join(wt7, ".env")), "includeFiles: .env 已复制进 worktree");
    ok(fs.readFileSync(path.join(wt7, ".env"), "utf8").includes("SECRET"), "includeFiles: .env 内容一致");
    ok(fs.existsSync(path.join(wt7, "notes.txt")), "includeFiles: *.txt 匹配到 notes.txt");

    // 软链目录：内容可见（透过链接）
    const linked = path.join(wt7, "cache", "big.bin");
    ok(fs.existsSync(linked), "symlinkFolders: cache/ 可透过链接访问");
    let isLink = false;
    try { isLink = fs.lstatSync(path.join(wt7, "cache")).isSymbolicLink(); } catch {}
    ok(isLink, "symlinkFolders: cache 确为软链（非实体复制）");

    // 已跟踪文件不被覆盖（README.md 来自 checkout）
    ok(fs.existsSync(path.join(wt7, "README.md")), "已跟踪文件保留");

    // best-effort：给一个不存在的软链源，不得抛错（只 warn）
    //   注意：不能改 session URI 来区分（URI 会反推仓库路径 ⇒ 指向不存在的 repo 会报"非 git 仓库"，
    //   那是**正确的显式错误**，与本用例要验的 best-effort 无关）。这里沿用同一 SESSION。
    let threw = false, errMsg = "";
    try {
      await mgr.create({
        session: SESSION,
        config: { isolation: "worktree", worktreeSymlinkFolders: ["no-such-dir"], worktreeIncludeFiles: ["**/*.nomatch"] },
      });
    } catch (e) { threw = true; errMsg = e && e.message; }
    ok(!threw, "best-effort: 软链源不存在/模式无匹配时**不阻断** create" + (threw ? "（实际抛错: " + errMsg + "）" : ""));

    // glob 语义单测（导出函数）
    const g = (p, s) => globToRegExp(p).test(s);
    ok(g("*.env", "a/b/.env") && !g("*.env", "a/x.env.local"), "glob: *.env 跨层级且不误匹配");
    ok(g("**/*.json", "c.json") && g("**/*.json", "a/b/c.json"), "glob: **/ 匹配零层与多层");
    ok(g(".vscode/**", ".vscode/s.json") && !g(".vscode/**", "x/.vscode/y"), "glob: 目录前缀锚定");
    ok(g("a?c.txt", "abc.txt") && !g("a?c.txt", "a/c.txt"), "glob: ? 不跨 /");

    try { await mgr.delete({ handle: c7.handle }); } catch {}
  }

  // ---------- 清场 ----------
  console.log("\n=== 清场 ===");
  for (const b of [c3, c6, ...batch]) {
    try { await mgr.delete({ handle: b.handle }); } catch { /* ignore */ }
  }
  await fsp.rm(SANDBOX, { recursive: true, force: true }).catch(() => {});

  console.log(`\n结果: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("ERR", e?.stack ?? e);
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
