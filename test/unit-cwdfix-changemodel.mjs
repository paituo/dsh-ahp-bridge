// ★ 验收测试（2026-10-14）：changeModel 抢跑建 thread 时的 cwd 解析正确性
//
// 背景（真机血案 20260814-0838）：
//   changeModel 走 tt 原生 Promise.all，时序**先于** sendMessage 触发：
//     08:38:10.383 changeModel reroute
//     08:38:10.384 thread/start: cwd=C:/Users/liuyue/WorkBuddy/... (cfg.cwd)  ← 会话 cwd 被写死
//     08:38:10.542 sendMessage reroute → resolveWd: cwd=e:/分析数据/chrome     ← 来晚了
//   ⇒ DSH 会话 header.cwd 与 VS Code 会话工作目录不符 ⇒ Web 归组失败（未分组）。
//
// 本测试验证修复后的**解析契约**（changeModel 现与 sendMessage 同用 resolveSessionWorkingDir）：
//   给定真机同形态输入（chatKey = ahp-chat://default/<base64url("dsh:/<uuid>")>，
//   stateManager.getSessionState 返回 { workingDirectories: ["file:///e:/分析数据/chrome"] }），
//   解析结果必须是 e:/分析数据/chrome（而非 cfg.cwd）。
import { resolveSessionWorkingDir, expandChatUriVariants } from "../src/inject-snippet.mjs";

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("  FAIL " + name + "\n       got=" + JSON.stringify(got) + "\n       want=" + JSON.stringify(want)); }
};

/**
 * 复刻运行时 resolveWd 的解析序（inject-snippet.mjs:884-914）：
 *   pushCand(chatKey) → pushCand(chatContext 的 configurationResource/session/resource)
 *   每个候选都做 expandChatUriVariants 展开；逐个喂给 getSessionState 查 workingDirectories。
 * ★ 这是 changeModel 与 sendMessage 共用的**同一解析序**。
 */
const resolveWdLike = (candidates, getSessionState) => {
  const all = [];
  for (const c of candidates) {
    if (c == null) continue;
    const s = typeof c === "string" ? c : (typeof c.toString === "function" ? c.toString() : null);
    if (!s) continue;
    all.push(s);
    try { for (const x of expandChatUriVariants(s)) all.push(x); } catch (_) {}
  }
  for (const uri of all) {
    const st = getSessionState(uri);
    const wds = st && st.workingDirectories;
    if (Array.isArray(wds) && wds.length) {
      for (const w of wds) {
        const p = typeof w === "string" ? w.replace(/^file:\/\/\//, "") : (w && w.fsPath);
        if (p) return { wd: p, hitUri: uri };
      }
    }
  }
  return { wd: undefined, hitUri: null };
};

// 真机实测：chat URI = ahp-chat://default/ZHNoOi9jMGMwYmY3NC03MzYyLTQ5MTktOGYxMC0zZTg4NmE4NGYwNTU
//   解码 = dsh:/c0c0bf74-7362-4919-8f10-3e886a84f055
const REAL_CHAT_URI = "ahp-chat://default/ZHNoOi9jMGMwYmY3NC03MzYyLTQ5MTktOGYxMC0zZTg4NmE4NGYwNTU";
const REAL_SESSION_URI = "dsh:/c0c0bf74-7362-4919-8f10-3e886a84f055";
const REAL_WD = "e:/分析数据/chrome";

const toUri = (u) => (typeof u === "string" ? u : u && typeof u.toString === "function" ? u.toString() : String(u));

// —— 场景 1：changeModel 拿到的 chatLike 是 chat URI 字符串（真机形态） ——
//   stateManager 只按内层 dsh:/<uuid> 索引（实证：ahp-chat:// 需 base64 解码后查）
{
  const probes = [];
  const getSS = (u) => {
    probes.push(u);
    if (u === REAL_SESSION_URI) return { workingDirectories: [`file:///${REAL_WD}`] };
    return undefined;
  };
  const { wd, hitUri } = resolveWdLike([REAL_CHAT_URI], getSS);
  t("changeModel: chat URI → 解析出真实会话工作目录", wd, REAL_WD);
  t("  且确以内层 dsh:/<uuid> 命中（base64 解码生效）", hitUri, REAL_SESSION_URI);
}

// —— 场景 2：changeModel 拿到的 chatLike 是对象（含 chatUri） ——
{
  const getSS = (u) => (u === REAL_SESSION_URI ? { workingDirectories: [{ fsPath: REAL_WD }] } : undefined);
  const chatLike = { chatUri: REAL_CHAT_URI, resource: REAL_CHAT_URI };
  const { wd } = resolveWdLike([chatLike, chatLike.configurationResource, chatLike.session, chatLike.resource], getSS);
  t("changeModel: chatLike 对象 → 解析正确", wd, REAL_WD);
}

// —— 场景 3：解析失败必须返回 undefined（而非误报 cfg.cwd） ——
//   调用方据此回落 cfg.cwd —— 这是「零回归」契约：失败时行为与旧版一致。
{
  const getSS = () => undefined;
  const { wd } = resolveWdLike([REAL_CHAT_URI], getSS);
  t("解析失败 → undefined（由调用方回落 cfg.cwd）", wd, undefined);
}

// —— 场景 4：消费方契约核对（源码级）——
//   修复要求 changeModel 的 ensureThread 调用**必须**传解析结果，不得再直接传 cfg.cwd。
{
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(__dirname, "..", "src", "inject-snippet.mjs"), "utf8");
  // 修复后的签名：changeModel 内先 resolveWd(chatLike, key)，再 ensureThread(key, wd || cfg.cwd)
  const okResolve = /resolveWd\(chatLike,\s*key\)/.test(src);
  const okUse = /ensureThread\(key,\s*wd\s*\|\|\s*cfg\.cwd\)/.test(src);
  t("源码：changeModel 调用 resolveWd(chatLike, key)", okResolve, true);
  t("源码：changeModel 用 wd || cfg.cwd 建 thread（非裸 cfg.cwd）", okUse, true);
  // 反向：不得再存在 `ensureThread(key, cfg.cwd)` 的裸用法
  const badRaw = /ensureThread\(key,\s*cfg\.cwd\)/.test(src);
  t("源码：已消除 ensureThread(key, cfg.cwd) 裸用法", badRaw, false);
}

console.log("\n结果: " + pass + " pass, " + fail + " fail");
process.exit(fail ? 1 : 0);
