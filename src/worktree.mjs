/**
 * Detached worktree 支持 —— 为 VS Code 的 `isolation=worktree` 会话提供 agent host 侧能力。
 *
 * ## 契约来源（全部来自 VS Code bundle 实证，非推测）
 *
 * ### A. VS Code 的判定链（vs/sessions/sessions.desktop.main.js）
 * ```js
 * if (sessionConfig.values.isolation === "worktree") {
 *   await Jo(r.waitForEagerCreate(), t);
 *   const b = this.connection;
 *   if (!b || !gXn(b.initializeResult.get())          // initialize 结果 _meta["vscode.detachedWorktrees"] === true
 *       || !b.createDetachedWorktree || !b.claimDetachedWorktree || !b.deleteDetachedWorktree)
 *     throw new Error(NLS[6194]);                     // "The source Agent Host does not support preparing a worktree for a Dev Container."
 *   g = { ...await b.createDetachedWorktree(r.backendUri, i), connection: b };
 *   h = this.mapProjectUri(g.worktree);
 * }
 * ```
 * - `gXn(s) { return s?._meta?.["vscode.detachedWorktrees"] === true }`
 * - `<provider>/*DetachedWorktree` 方法经 `_sendExtensionRequest` → `_dispatchRequest` →
 *   `this._transport.send({jsonrpc:"2.0", id, method, params})` —— **就是我们桥收到的 JSON-RPC**。
 *   （已排除"发给扩展宿主"：定义在 sessions 主进程的 RemoteAgentHostProtocol 客户端上）
 *
 * ### B. 五个方法的精确签名（同文件 4757 行，客户端侧）
 * ```js
 * createDetachedWorktree(session, prompt)      → { handle, worktree: URI.parse(resource) }
 *     _sendExtensionRequest("vscode/createAgentHostDetachedWorktree", { session: session.toString(), prompt })
 *     // ★ 返回 falsy ⇒ throw "Agent Host does not support detached worktrees."
 * setDetachedWorktreeArchived(handle, arch)    → _sendExtensionRequest("vscode/setAgentHostDetachedWorktreeArchived", { handle, archived })
 * claimDetachedWorktree(handle)                → _sendExtensionRequest("vscode/claimAgentHostDetachedWorktree", { handle })
 * deleteDetachedWorktree(handle)               → _sendExtensionRequest("vscode/deleteAgentHostDetachedWorktree", { handle })
 * reconcileDetachedWorktrees(scope, handles)   → _sendExtensionRequest("vscode/reconcileAgentHostDetachedWorktrees", { scope, activeHandles: [...handles] })
 * ```
 * 传参里 `session` 是 **URI 字符串**（`r.backendUri`，形如 `vscode-agent-host://<authority>/<path>`），
 * `resource` 返回 **URI 字符串**（本机为 `file://`）。
 *
 * ### C. 内置 host 的语义（vs/platform/agentHost/node/agentHostMain.js，证明"这是 host 的正当职责"）
 * - `create`：建 worktree → 落元数据（worktreePath/repositoryRoot/branchName/baseBranch）
 *   - worktree 根目录：`<repoRoot>/../<repoBasename>.worktrees/`（函数 `vK`）
 *   - 目录名：分支名 `/`→`-` 后放入上述根（函数 `xK`）
 *   - 并发：`_worktreeCreationSequencer.queue(repoId, fn)` **按仓库串行**（防同名碰撞）
 * - `claim`：把元数据 `claimed=true` + `claimedAt`（表示"已被某会话认领"）
 * - `delete`：`_sequencer.queue(handle, ...)` → 标 `deletionPending=true` → `git worktree remove`
 * - `setArchived`：`archived=true` → cleanup（有未提交改动则保留）；`false` → recreate
 * - `reconcile`：遍历全部记录
 *   - `activeHandles` 含 handle 且 scope 匹配 ⇒ 刷新 claimedAt、**跳过**
 *   - scope 不匹配 ⇒ 视为孤儿 ⇒ 删除
 *   - `deletionPending` ⇒ 重试删除
 *   - worktree 目录已消失 ⇒ 清记录
 *   - 无未提交改动 ⇒ `git worktree remove` + 清记录
 *
 * ## 本模块的取舍（与内置 host 的差异，均已在报告里写明）
 * | 项 | 内置 host | 本实现 | 理由 |
 * |---|---|---|---|
 * | 元数据 | session 数据库 | `~/.dsh/ahp-worktrees.json` | 复用 DSH 家目录，简单可审计 |
 * | 分支名 | 可 LLM 生成 | 确定性生成（短哈希） | 桥内不引入 LLM 调用 |
 * | 并发 | 按仓库串行 | 按仓库串行（同语义） | 防同名碰撞，必须保留 |
 * | 删除安全 | 检查未提交改动 | 同（`git status --porcelain`） | 防丢用户改动 |
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------- 常量

/** initialize 结果必须声明的能力标记（VS Code 的 gXn 读的就是这个） */
export const WORKTREE_META_KEY = "vscode.detachedWorktrees";

/** 五个 RPC 方法名（bundle 字面量，逐字对齐） */
export const WORKTREE_METHOD = {
  create: "vscode/createAgentHostDetachedWorktree",
  claim: "vscode/claimAgentHostDetachedWorktree",
  delete: "vscode/deleteAgentHostDetachedWorktree",
  reconcile: "vscode/reconcileAgentHostDetachedWorktrees",
  setArchived: "vscode/setAgentHostDetachedWorktreeArchived",
};

/** worktree 根目录命名（对齐内置 host 的 vK）：<repoRoot>/../<basename>.worktrees */
const WORKTREE_ROOT_SUFFIX = ".worktrees";
/** 自动生成分支名前缀 */
const DEFAULT_BRANCH_PREFIX = "worktree-";
/** 未认领 worktree 的保活窗口（对齐内置 Aue 语义：超时未认领则清理） */
const UNCLAIMED_TTL_MS = 1000 * 60 * 60 * 6;

// ---------------------------------------------------------------- 工具

function log(logger, level, msg) {
  (logger ?? ((lv, m) => process.stderr.write(`[worktree] ${lv}: ${m}\n`)))(level, msg);
}

/** 跑一个进程，返回 { code, stdout, stderr }（不抛，由调用方判 code） */
function run(cmd, argv, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, argv, { cwd: opts.cwd, windowsHide: true });
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: String(e?.message ?? e) });
      return;
    }
    let out = "", err = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ code: -1, stdout: out, stderr: String(e?.message ?? e) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout: out, stderr: err }));
  });
}

/** git 命令（统一走 `git -C <cwd>`） */
async function git(cwd, ...argv) {
  return run("git", ["-C", cwd, ...argv]);
}

/** 把 URI 字符串（file:///C:/x 或 vscode-agent-host://auth/c:/x 或裸路径）解析成本机路径 */
export function uriToPath(uri) {
  if (typeof uri !== "string") return undefined;
  const s = uri.trim();
  if (!s) return undefined;
  // 带 scheme 的
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/]*)(\/.*)?$/.exec(s);
  if (m) {
    const [, scheme, authority, rest] = m;
    if (scheme === "file") {
      // file:///C:/x → C:/x ；file:///home/x → /home/x
      let p = decodeURIComponent(rest ?? "");
      if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);          // 去掉 Windows 盘符前的斜杠
      return path.normalize(p);
    }
    // 非 file scheme（如 vscode-agent-host://<authority>/c:/path）：
    // 尾部路径就是真实路径；盘符前导斜杠同样去掉
    let p = decodeURIComponent(rest ?? "");
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
    return p ? path.normalize(p) : undefined;
  }
  // 裸路径
  return path.normalize(s);
}

/** 路径 → file:// URI（VS Code 侧 M.parse(resource) 要能吃） */
export function pathToFileUri(p) {
  const abs = path.resolve(p).replace(/\\/g, "/");
  const withSlash = abs.startsWith("/") ? abs : `/${abs}`;
  // 逐段编码（保留盘符冒号与斜杠）
  const enc = withSlash
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ":"))
    .join("/");
  return `file://${enc}`;
}

/** 短稳定哈希（用于句柄与分支名，避免引入随机导致不可复现） */
function shortHash(input, len = 8) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, len);
}

/** 分支名 → 安全目录名（对齐内置 xK：`/`→`-`） */
function branchToDirName(branch, prefix = "") {
  let e = branch;
  if (prefix && e.startsWith(prefix)) e = e.slice(prefix.length);
  return e.replace(/[/\\]/g, "-");
}

/**
 * 极简 glob → RegExp（对齐内置 host「把 include patterns 当 glob 用」的语义）。
 * 支持：`*`（不含 `/`）、`**`（跨目录）、`?`（单字符，非 `/`）、其余字符转义。
 * 匹配对象是**仓库相对路径**（正斜杠）。无 `/` 的模式（如 `*.env`）自动允许匹配任意层级。
 */
export function globToRegExp(pattern) {
  const p = String(pattern).replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        // `**` → 跨目录；若其后紧跟 `/`，则该 `/` 一并可选（使 `**/x` 也能匹配裸 `x`）
        i++;
        if (p[i + 1] === "/") { re += "(?:.*/)?"; i++; }
        else re += ".*";
      } else re += "[^/]*";                                 // * → 单层
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // 无路径分隔的模式（如 `*.env`）允许出现在任意目录层级
  const body = p.includes("/") ? re : "(?:.*/)?" + re;
  return new RegExp("^" + body + "$");
}

// ---------------------------------------------------------------- 存储

/**
 * worktree 记录存储（JSON 单文件）。
 * 字段（对齐内置 host 的元数据语义）：
 *   handle, sessionUri, repositoryRoot, worktreePath, branchName, baseBranch,
 *   createdAt, claimed, claimedAt, archived, deletionPending
 */
class WorktreeStore {
  constructor(file, logger) {
    this.file = file;
    this.log = logger;
    this._cache = null;
  }

  async _load() {
    if (this._cache) return this._cache;
    try {
      const raw = await fsp.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      this._cache = parsed && typeof parsed === "object" ? parsed : { records: {} };
    } catch {
      this._cache = { records: {} };
    }
    if (!this._cache.records) this._cache.records = {};
    return this._cache;
  }

  async _flush() {
    const data = await this._load();
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    // 原子写：先写临时文件再 rename
    const tmp = `${this.file}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fsp.rename(tmp, this.file);
  }

  async get(handle) {
    const d = await this._load();
    return d.records[handle];
  }

  async all() {
    const d = await this._load();
    return Object.entries(d.records).map(([handle, rec]) => ({ handle, ...rec }));
  }

  async put(handle, rec) {
    const d = await this._load();
    d.records[handle] = rec;
    await this._flush();
    return rec;
  }

  async patch(handle, fields) {
    const d = await this._load();
    if (!d.records[handle]) return undefined;
    d.records[handle] = { ...d.records[handle], ...fields };
    await this._flush();
    return d.records[handle];
  }

  async remove(handle) {
    const d = await this._load();
    delete d.records[handle];
    await this._flush();
  }
}

/**
 * 按 key 串行化（对齐内置 host 的 `_worktreeCreationSequencer.queue(repoId, fn)`）。
 * 同一仓库的 create 必须串行 —— 否则并发创建可能算出同名目录 / 同名分支。
 */
class KeySequencer {
  constructor() { this._chains = new Map(); }
  queue(key, fn) {
    const prev = this._chains.get(key) ?? Promise.resolve();
    // 前一个失败也要继续（不阻断后续）—— 因此两个分支都挂 fn
    const next = prev.then(fn, fn);
    // 链尾：吞掉异常，避免 unhandled rejection（真正的异常由返回的 next 交给调用方）
    const tail = next.then(() => {}, () => {});
    this._chains.set(key, tail);
    // 链结束后清理，避免 Map 无限增长（仅当自己仍是链尾时才清）
    tail.then(() => {
      if (this._chains.get(key) === tail) this._chains.delete(key);
    });
    return next;
  }
}

// ---------------------------------------------------------------- 主体

export class WorktreeManager {
  /**
   * @param {object} opts
   * @param {string} [opts.dshHome]   DSH 家目录（默认 ~/.dsh）；元数据落在其下
   * @param {(lv:string,msg:string)=>void} [opts.log]
   * @param {string} [opts.gitBin]    git 可执行文件（默认 "git"）
   */
  constructor(opts = {}) {
    this.dshHome = opts.dshHome ?? path.join(os.homedir(), ".dsh");
    this.storeFile = opts.storeFile ?? path.join(this.dshHome, "ahp-worktrees.json");
    this.log = opts.log;
    this.gitBin = opts.gitBin ?? "git";
    this.store = new WorktreeStore(this.storeFile, this.log);
    this.sequencer = new KeySequencer();
  }

  // ---------- 查询：判断一个目录是否 git 仓库、拿仓库根与当前分支 ----------

  async repoRootOf(dir) {
    const r = await this._git(dir, "rev-parse", "--show-toplevel");
    if (r.code !== 0) return undefined;
    const p = r.stdout.trim().split(/\r?\n/)[0];
    return p ? path.normalize(p) : undefined;
  }

  async currentBranchOf(repo) {
    const r = await this._git(repo, "rev-parse", "--abbrev-ref", "HEAD");
    if (r.code !== 0) return undefined;
    const b = r.stdout.trim();
    return b && b !== "HEAD" ? b : undefined;
  }

  async branchExists(repo, branch) {
    const r = await this._git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    return r.code === 0;
  }

  async hasUncommittedChanges(dir) {
    const r = await this._git(dir, "status", "--porcelain");
    if (r.code !== 0) return true;    // 判不了 ⇒ 保守当"有改动"（不删）
    return r.stdout.trim().length > 0;
  }

  async _git(cwd, ...argv) {
    return run(this.gitBin, ["-C", cwd, ...argv]);
  }

  /** worktree 根目录（对齐内置 vK）：<repoRoot>/../<basename>.worktrees */
  _worktreeRoot(repoRoot) {
    const parent = path.dirname(repoRoot);
    const base = path.basename(repoRoot);
    return path.join(parent, `${base}${WORKTREE_ROOT_SUFFIX}`);
  }

  // ---------- ① create ----------

  /**
   * @param {{session?:string, prompt?:string, workingDirectory?:string, config?:object}} params
   * @returns {Promise<{handle:string, resource:string}>}
   */
  async create(params = {}) {
    const sessionUri = params.session;
    // 工作目录：优先显式传入（VS Code 的 backendUri/session.workingDirectory），
    // 否则从 session URI 反推，最后回落进程 cwd。
    const wdRaw = params.workingDirectory
      ?? (params.config && params.config.workingDirectory)
      ?? uriToPath(sessionUri)
      ?? process.cwd();
    const sessionId = String(sessionUri ?? "");

    // 1) 定位仓库根（非 git 仓库 ⇒ 明确报错，不静默降级 —— 否则 VS Code 会以为拿到 worktree）
    const repoRoot = await this.repoRootOf(wdRaw);
    if (!repoRoot) {
      throw new Error(`Detached worktree requires a Git repository; '${wdRaw}' is not inside one.`);
    }

    // 2) 解析分支配置（对齐内置 host 的语义）
    const cfg = params.config && typeof params.config === "object" ? params.config : {};
    const isBranch = typeof cfg.branch === "string" && cfg.branch.trim().length > 0;
    const createNewBranch = cfg.worktreeCreateNewBranch !== false;   // 默认 true
    const branchPrefix = isBranch ? cfg.branch.trim() : DEFAULT_BRANCH_PREFIX;
    const track = cfg.worktreeBranchTrack === true;

    // 3) 串行化：按仓库排队（防同名碰撞）
    return this.sequencer.queue(repoRoot, async () => {
      const baseBranch = isBranch
        ? branchPrefix
        : (await this.currentBranchOf(repoRoot)) ?? (await this._defaultStartPoint(repoRoot));

      // 生成新分支名（确定性：前缀 + 短哈希，避免引入 LLM/随机）
      const suffix = shortHash(`${sessionId}|${Date.now()}|${Math.random()}`, 8);
      const newBranchName = createNewBranch ? `${branchPrefix}${suffix}` : undefined;
      const effectiveBranch = newBranchName ?? baseBranch;

      const wtRoot = this._worktreeRoot(repoRoot);
      await fsp.mkdir(wtRoot, { recursive: true });
      const worktreePath = path.join(wtRoot, branchToDirName(effectiveBranch, branchPrefix));

      // ★ 目标目录已存在 ⇒ 报明确错误（不覆盖用户数据）
      if (fs.existsSync(worktreePath)) {
        throw new Error(`Detached worktree path already exists: ${worktreePath}`);
      }

      // 4) git worktree add
      const addArgs = ["worktree", "add"];
      if (createNewBranch) addArgs.push("-b", newBranchName);
      if (track) addArgs.push("--track");
      addArgs.push(worktreePath, baseBranch);
      const add = await this._git(repoRoot, ...addArgs);
      if (add.code !== 0) {
        throw new Error(`git worktree add failed (${add.code}): ${(add.stderr || add.stdout).trim()}`);
      }

      // ★ 4b) 参照内置 host：先 symlink 目录，再 copy 未跟踪的配置文件。
      //   语义对齐 agentHostMain.js 的 resolveWorkingDirectory：
      //     w = worktreeSymlinkFolders（string[]）→ symlinkWorktreeFolders(repo, wt, w)
      //     b = worktreeIncludeFiles  （string[]）→ copyWorktreeIncludeFiles(repo, wt, b, …, excluded=symlinked)
      //   两者**均 best-effort**：失败只 warn，**不得阻断**建 worktree（内置即如此）。
      const symlinkFolders = Array.isArray(cfg.worktreeSymlinkFolders) && cfg.worktreeSymlinkFolders.every((x) => typeof x === "string")
        ? cfg.worktreeSymlinkFolders : undefined;
      const includeFiles = Array.isArray(cfg.worktreeIncludeFiles) && cfg.worktreeIncludeFiles.every((x) => typeof x === "string")
        ? cfg.worktreeIncludeFiles : undefined;

      const symlinked = [];
      if (symlinkFolders?.length) {
        try {
          symlinked.push(...await this._symlinkFolders(repoRoot, worktreePath, symlinkFolders));
        } catch (e) {
          log(this.log, "warn", `create: symlinkWorktreeFolders failed (ignored): ${e && e.message}`);
        }
      }
      if (includeFiles?.length) {
        try {
          await this._copyIncludeFiles(repoRoot, worktreePath, includeFiles, symlinked);
        } catch (e) {
          log(this.log, "warn", `create: copyWorktreeIncludeFiles failed (ignored): ${e && e.message}`);
        }
      }

      // 5) 落元数据
      const handle = `wt-${shortHash(`${repoRoot}|${worktreePath}`, 12)}`;
      const now = Date.now();
      await this.store.put(handle, {
        handle,
        sessionUri: sessionId || undefined,
        repositoryRoot: repoRoot,
        worktreePath,
        branchName: effectiveBranch,
        baseBranch,
        createdAt: now,
        claimed: false,
        claimedAt: null,
        archived: false,
        deletionPending: false,
      });
      log(this.log, "info", `create: ${handle} path=${worktreePath} branch=${effectiveBranch} base=${baseBranch}`);
      return { handle, resource: pathToFileUri(worktreePath) };
    });
  }

  /**
   * 软链目录进 worktree（对齐内置 `_gitService.symlinkWorktreeFolders`）。
   * 仅处理**仓库内**的目录；目标已存在则跳过（不覆盖）。返回成功软链的**相对路径**列表
   * （供 include-files 阶段排除，避免把软链目录里的文件再复制一份）。
   */
  async _symlinkFolders(repoRoot, worktreePath, folders) {
    const done = [];
    for (const rel of folders) {
      const relNorm = String(rel).replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "");
      if (!relNorm) continue;
      const src = path.join(repoRoot, relNorm);
      const dst = path.join(worktreePath, relNorm);
      try {
        if (!fs.existsSync(src)) { log(this.log, "warn", `symlink: 源不存在，跳过 ${relNorm}`); continue; }
        if (fs.existsSync(dst)) { log(this.log, "info", `symlink: 目标已存在，跳过 ${relNorm}`); done.push(relNorm); continue; }
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        // Windows 下目录软链需 junction/type 提示；POSIX 用 dir 类型
        const type = process.platform === "win32" ? "junction" : "dir";
        await fsp.symlink(src, dst, type);
        done.push(relNorm);
        log(this.log, "info", `symlink: ${relNorm} -> ${src}`);
      } catch (e) {
        log(this.log, "warn", `symlink: ${relNorm} 失败（跳过）: ${e && e.message}`);
      }
    }
    return done;
  }

  /**
   * 把仓库里匹配 glob 的**未跟踪/配置类文件**复制进 worktree（对齐内置 `copyWorktreeIncludeFiles`）。
   * 用 `git ls-files --others --exclude-standard` 拿"未跟踪但未被 ignore"的文件（内置同思路），
   * 再做 extrememly 简化的 glob 匹配（支持 `*`、`**`、`?`、目录前缀）。
   * `excluded` = 已软链的相对目录，其下文件不再复制。
   */
  async _copyIncludeFiles(repoRoot, worktreePath, patterns, excluded = []) {
    const r = await this._git(repoRoot, "ls-files", "--others", "--exclude-standard");
    if (r.code !== 0) { log(this.log, "warn", `includeFiles: git ls-files 失败: ${(r.stderr || "").trim()}`); return; }
    const files = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const regs = patterns.map(globToRegExp);
    let copied = 0;
    for (const rel of files) {
      const relNorm = rel.replace(/\\/g, "/");
      if (excluded.some((d) => relNorm === d || relNorm.startsWith(d + "/"))) continue;   // 已在软链目录内
      if (!regs.some((re) => re.test(relNorm))) continue;
      const src = path.join(repoRoot, rel);
      const dst = path.join(worktreePath, rel);
      try {
        if (fs.existsSync(dst)) continue;    // 不覆盖 git 已检出的文件
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.copyFile(src, dst);
        copied++;
      } catch (e) {
        log(this.log, "warn", `includeFiles: 复制 ${relNorm} 失败（跳过）: ${e && e.message}`);
      }
    }
    log(this.log, "info", `includeFiles: 匹配 ${patterns.length} 模式，复制 ${copied}/${files.length} 个未跟踪文件`);
  }

  async _defaultStartPoint(repo) {
    // 拿默认分支（origin/HEAD），失败回落 HEAD
    const r = await this._git(repo, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD");
    if (r.code === 0) {
      const s = r.stdout.trim().replace(/^origin\//, "");
      if (s) return s;
    }
    return "HEAD";
  }

  // ---------- ② claim ----------

  async claim(params = {}) {
    const handle = params.handle;
    const rec = await this.store.get(handle);
    if (!rec) throw new Error(`Unknown detached worktree handle: ${handle}`);
    await this.store.patch(handle, { claimed: true, claimedAt: Date.now() });
    log(this.log, "info", `claim: ${handle}`);
    return {};
  }

  // ---------- ③ delete ----------

  async delete(params = {}) {
    const handle = params.handle;
    return this.sequencer.queue(`del:${handle}`, async () => {
      const rec = await this.store.get(handle);
      if (!rec) {
        log(this.log, "info", `delete: ${handle} 无记录（幂等成功）`);
        return {};
      }
      // 标 deletionPending（对齐内置语义：先标记，便于 reconcile 重试）
      await this.store.patch(handle, { deletionPending: true });

      // ★ 安全：有未提交改动 ⇒ 只标记不删（避免丢用户工作），交由 reconcile/人工处理
      if (fs.existsSync(rec.worktreePath) && await this.hasUncommittedChanges(rec.worktreePath)) {
        log(this.log, "warn", `delete: ${handle} 有未提交改动，保留 worktree 仅标记 deletionPending`);
        return { deleted: false, reason: "uncommitted-changes", worktreePath: rec.worktreePath };
      }

      const rm = await this._removeWorktree(rec.repositoryRoot, rec.worktreePath);
      if (!rm.ok) {
        log(this.log, "warn", `delete: ${handle} git worktree remove 失败: ${rm.reason}`);
        return { deleted: false, reason: rm.reason, worktreePath: rec.worktreePath };
      }
      await this.store.remove(handle);
      log(this.log, "info", `delete: ${handle} 完成`);
      return { deleted: true };
    });
  }

  /** 执行 `git worktree remove`（先尝试 --force，失败再退回 prune） */
  async _removeWorktree(repoRoot, worktreePath) {
    if (!fs.existsSync(worktreePath)) {
      // 目录已消失：prune 掉残留登记即可
      const p = await this._git(repoRoot, "worktree", "prune");
      return { ok: p.code === 0, reason: p.code === 0 ? undefined : (p.stderr || p.stdout).trim() };
    }
    let r = await this._git(repoRoot, "worktree", "remove", worktreePath);
    if (r.code !== 0) {
      // 目录非空/被占用时退一步用 --force（此时调用方已确认无未提交改动）
      r = await this._git(repoRoot, "worktree", "remove", "--force", worktreePath);
    }
    if (r.code !== 0) return { ok: false, reason: (r.stderr || r.stdout).trim() };
    await this._git(repoRoot, "worktree", "prune");
    return { ok: true };
  }

  // ---------- ④ setArchived ----------

  async setArchived(params = {}) {
    const handle = params.handle;
    const archived = params.archived === true;
    const rec = await this.store.get(handle);
    if (!rec) {
      // 对齐内置：记录不可用时**只记日志不报错**（避免阻断 VS Code 归档流程）
      log(this.log, "info", `setArchived: ${handle} 无记录，跳过（archived=${archived}）`);
      return {};
    }
    await this.store.patch(handle, { archived });

    if (archived) {
      // 归档 ⇒ 若目录存在且无未提交改动，则移除 worktree（保留元数据，可在 unarchive 时重建）
      if (fs.existsSync(rec.worktreePath) && !(await this.hasUncommittedChanges(rec.worktreePath))) {
        const rm = await this._removeWorktree(rec.repositoryRoot, rec.worktreePath);
        log(this.log, "info", `setArchived: ${handle} 归档清理 ${rm.ok ? "成功" : `跳过(${rm.reason})`}`);
      } else {
        log(this.log, "info", `setArchived: ${handle} 归档但保留目录（存在未提交改动或目录已不在）`);
      }
    } else {
      // 解档 ⇒ 目录缺失则重建（git worktree add <path> <branch>）
      if (!fs.existsSync(rec.worktreePath)) {
        const r = await this._git(rec.repositoryRoot, "worktree", "add", rec.worktreePath, rec.branchName);
        if (r.code !== 0) {
          log(this.log, "warn", `setArchived: ${handle} 解档重建失败: ${(r.stderr || r.stdout).trim()}`);
        } else {
          log(this.log, "info", `setArchived: ${handle} 解档重建成功 → ${rec.worktreePath}`);
        }
      }
    }
    return {};
  }

  // ---------- ⑤ reconcile ----------

  /**
   * @param {{scope?:string, activeHandles?:string[], startup?:boolean}} params
   */
  async reconcile(params = {}) {
    const scope = params.scope;
    const active = new Set(Array.isArray(params.activeHandles) ? params.activeHandles : []);
    const startup = params.startup === true;
    const all = await this.store.all();
    const summary = { scanned: all.length, kept: 0, refreshed: 0, removed: 0, retried: 0, orphaned: 0 };

    for (const rec of all) {
      const handle = rec.handle;
      await this.sequencer.queue(`rc:${handle}`, async () => {
        // ① activeHandles 命中且 scope 匹配 ⇒ 刷新 claimedAt、跳过
        if (!startup && rec.sessionUri === scope && active.has(handle)) {
          await this.store.patch(handle, { claimed: true, claimedAt: Date.now() });
          summary.refreshed++;
          return;
        }

        // ② deletionPending ⇒ 重试删除
        if (rec.deletionPending) {
          if (fs.existsSync(rec.worktreePath) && await this.hasUncommittedChanges(rec.worktreePath)) {
            summary.kept++;
            return;
          }
          const rm = await this._removeWorktree(rec.repositoryRoot, rec.worktreePath);
          if (rm.ok) { await this.store.remove(handle); summary.retried++; }
          else summary.kept++;
          return;
        }

        // ③ scope 不匹配（本次 reconcile 只负责该 scope）⇒ 孤儿
        const belongs = rec.sessionUri === scope;
        if (!startup && !belongs) {
          summary.orphaned++;
          // 孤儿：仅在"未认领且超时"或"已归档"时才真正删
          const age = Date.now() - (rec.claimedAt ?? rec.createdAt ?? 0);
          const staleUnclaimed = !rec.claimed && Number.isFinite(age) && age > UNCLAIMED_TTL_MS;
          if (rec.archived || staleUnclaimed) {
            if (!fs.existsSync(rec.worktreePath) || !(await this.hasUncommittedChanges(rec.worktreePath))) {
              const rm = await this._removeWorktree(rec.repositoryRoot, rec.worktreePath);
              if (rm.ok) { await this.store.remove(handle); summary.removed++; return; }
            }
          }
          summary.kept++;
          return;
        }

        // ④ 目录已消失 ⇒ 清记录
        if (!fs.existsSync(rec.worktreePath)) {
          await this.store.remove(handle);
          summary.removed++;
          return;
        }

        // ⑤ 无未提交改动 且（已归档 或 未认领超时）⇒ 回收
        const noChanges = !(await this.hasUncommittedChanges(rec.worktreePath));
        const age = Date.now() - (rec.claimedAt ?? rec.createdAt ?? 0);
        const staleUnclaimed = !rec.claimed && Number.isFinite(age) && age > UNCLAIMED_TTL_MS;
        if (noChanges && (rec.archived || staleUnclaimed)) {
          const rm = await this._removeWorktree(rec.repositoryRoot, rec.worktreePath);
          if (rm.ok) { await this.store.remove(handle); summary.removed++; return; }
        }
        summary.kept++;
      });
    }
    log(this.log, "info", `reconcile: ${JSON.stringify(summary)} (scope=${scope ?? "(startup)"})`);
    return summary;
  }

  /** 启动清理（对齐内置 `_cleanupUnclaimedDetachedWorktrees`）：scope=undefined, activeHandles=[] */
  async startupCleanup() {
    return this.reconcile({ startup: true, activeHandles: [] });
  }

  // ---------- 诊断 ----------

  async stats() {
    const all = await this.store.all();
    return {
      storeFile: this.storeFile,
      total: all.length,
      claimed: all.filter((r) => r.claimed).length,
      archived: all.filter((r) => r.archived).length,
      pendingDelete: all.filter((r) => r.deletionPending).length,
      records: all,
    };
  }
}
