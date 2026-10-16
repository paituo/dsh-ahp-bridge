/**
 * 单测：验证注入的 v8 getChatMetadata 覆写对**真实 agentSessionData uuid** 返回合法元数据。
 *
 * 做法：把 P3 片段的 v8 段单独抠出来（或用同一份源码逻辑），在一个 mock base 上执行，
 *   断言：对 dsh:/<真实uuid> 返回对象（含 chat/startTime/modifiedTime），且 project.uri 指向真实目录。
 */
import fs from "node:fs";
import path from "node:path";

const APPDATA = process.env.APPDATA || "C:/Users/liuyue/AppData/Roaming";
const VS_ROOT = path.join(APPDATA, "Code", "agentSessionData");

// 取一个真实最近的 uuid
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dirs = fs.readdirSync(VS_ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && UUID_RE.test(d.name))
  .map((d) => {
    let mt = 0;
    try { mt = fs.statSync(path.join(VS_ROOT, d.name, "session.db")).mtimeMs; } catch (_) {}
    return { u: d.name, mt };
  })
  .sort((a, b) => b.mt - a.mt);
const target = dirs[0];
console.log("测试目标 uuid:", target.u, "mtime:", new Date(target.mt).toISOString());

// ── 复刻注入片段的 v8 逻辑（与 bundle 内完全同源）──
function makeOverride(base, log) {
  const _isWin = (() => { try { return process.platform === "win32"; } catch (_) { return true; } })();
  const _join = (...parts) => {
    const segs = parts.filter((x) => x !== undefined && x !== null && x !== "").map(String);
    if (segs.length === 0) return "";
    const RE_LEAD = new RegExp("^[" + String.fromCharCode(92) + String.fromCharCode(92) + "/]+");
    const RE_TRAIL = new RegExp("[" + String.fromCharCode(92) + String.fromCharCode(92) + "/]+$");
    let p = segs[0];
    for (let i = 1; i < segs.length; i++) {
      const s = segs[i].replace(RE_LEAD, "").replace(RE_TRAIL, "");
      if (!s) continue;
      p = p.replace(RE_TRAIL, "") + (_isWin ? String.fromCharCode(92) : "/") + s;
    }
    return p;
  };
  const _homeDir = (() => { try { return process.env.USERPROFILE || process.env.HOME || ""; } catch (_) { return ""; } })();
  const _sessionDataRoot = (() => {
    try {
      const appData = process.env.APPDATA || (_homeDir ? _join(_homeDir, "AppData", "Roaming") : "");
      return appData ? _join(appData, "Code", "agentSessionData") : "";
    } catch (_) { return ""; }
  })();
  let _fsPromise = null;
  let _fsSync = null;
  const _getFs = () => {
    if (!_fsPromise) {
      try {
        _fsPromise = import("node:fs").then((m) => { try { _fsSync = m && (m.default || m); } catch (_) {} return _fsSync; }).catch(() => null);
      } catch (_) { _fsPromise = Promise.resolve(null); }
    }
    return _fsPromise;
  };
  const _b64Decode = (b64) => {
    try {
      const norm = String(b64).replace(/-/g, "+").replace(/_/g, "/");
      try {
        if (typeof Buffer !== "undefined" && Buffer && typeof Buffer.from === "function") {
          return Buffer.from(norm, "base64").toString("utf8");
        }
      } catch (_) {}
      try { if (typeof atob === "function") return decodeURIComponent(escape(atob(norm))); } catch (_) {}
      try { if (typeof atob === "function") return atob(norm); } catch (_) {}
    } catch (_) {}
    return null;
  };
  const _UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const _uuidFromUri = (s) => {
    const t = String(s ?? "");
    const m = t.match(_UUID_RE);
    if (m) return m[1];
    const slash = t.indexOf("/", t.indexOf("://") + 3);
    if (slash >= 0) {
      const payload = t.slice(slash + 1);
      if (payload) {
        const dec = _b64Decode(payload);
        if (dec) { const m2 = dec.match(_UUID_RE); if (m2) return m2[1]; }
        if (/^[A-Za-z0-9_\-]+$/.test(payload)) {
          const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
          const dec2 = _b64Decode(padded);
          if (dec2) { const m3 = dec2.match(_UUID_RE); if (m3) return m3[1]; }
        }
      }
    }
    return null;
  };
  const _probeSessionDir = (uuid) => {
    const out = { exists: null, mtime: 0, dir: "" };
    try {
      if (!uuid || !_sessionDataRoot) return out;
      const dir = _join(_sessionDataRoot, uuid);
      out.dir = dir;
      if (!_fsSync) return out;
      try { out.exists = !!_fsSync.existsSync(dir); } catch (_) { out.exists = null; }
      if (out.exists) {
        try { out.mtime = _fsSync.statSync(dir).mtimeMs || 0; } catch (_) {}
        try {
          const dbPath = _join(dir, "session.db");
          if (_fsSync.existsSync(dbPath)) {
            const st = _fsSync.statSync(dbPath);
            if (st && st.mtimeMs) out.mtime = st.mtimeMs;
          }
        } catch (_) {}
      }
    } catch (_) {}
    return out;
  };
  const _mkMetadata = (chatUri, chatContext, registryFallback) => {
    const uuid = _uuidFromUri(chatUri);
    const probe = _probeSessionDir(uuid);
    const now = Date.now();
    const fbStart = registryFallback && typeof registryFallback.startTime === "number" ? registryFallback.startTime : 0;
    const fbMod = registryFallback && typeof registryFallback.modifiedTime === "number" ? registryFallback.modifiedTime : 0;
    const mt = probe.mtime || fbMod || fbStart || now;
    const st = probe.mtime || fbStart || mt;
    const chatStr = (chatUri && typeof chatUri.toString === "function") ? chatUri.toString() : String(chatUri ?? "");
    const wd = (chatContext && Array.isArray(chatContext.workingDirectories) && chatContext.workingDirectories.length)
      ? chatContext.workingDirectories
      : [];
    const md = { chat: chatStr, startTime: st, modifiedTime: mt, workingDirectories: wd };
    if (probe.dir && uuid) md.project = { uri: "file:///" + String(probe.dir).split(String.fromCharCode(92)).join("/"), displayName: uuid };
    return md;
  };
  const _origGetChatMetadata = base.getChatMetadata;
  base.getChatMetadata = async function (chatUri, chatContext, providerData, registryFallback) {
    let raw;
    try {
      if (typeof _origGetChatMetadata === "function")
        raw = await _origGetChatMetadata.call(this, chatUri, chatContext, providerData, registryFallback);
    } catch (_) { raw = undefined; }
    if (raw) return raw;
    try { await _getFs(); _fsSync = _fsSync || null; } catch (_) {}
    try {
      const md = _mkMetadata(chatUri, chatContext, registryFallback);
      log("info", "v8 getChatMetadata fallback: " + String(chatUri) + " → uuid=" + _uuidFromUri(chatUri));
      return md;
    } catch (e) {
      log("error", "v8 getChatMetadata fallback failed: " + (e && e.message));
      const fallbackChat = (chatUri && typeof chatUri.toString === "function") ? chatUri.toString() : String(chatUri ?? "");
      return { chat: fallbackChat, startTime: Date.now(), modifiedTime: Date.now(), workingDirectories: [] };
    }
  };
  return { override: base.getChatMetadata, _sessionDataRoot };
}

// ── mock base：原生 getChatMetadata 返回 undefined（模拟 copilotcli 找不到 sdkSessionId）──
const logs = [];
const base = { async getChatMetadata() { return undefined; } };
const r = makeOverride(base, (l, m) => logs.push(l + ": " + m));
console.log("sessionDataRoot =", r._sessionDataRoot);

const results = [];
async function check(uri, label, expectObject) {
  const md = await base.getChatMetadata(uri, {}, { sdkSessionId: "some-other-uuid" }, undefined);
  const ok = expectObject ? (md && typeof md === "object" && md.chat === uri) : (!md);
  results.push(ok);
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  console.log(`      → ${JSON.stringify(md)}`);
}

console.log("\n=== 断言 ===");
// ★★★ 最重要的一条：真实入参形态 = ahp-chat://default/<base64url("dsh:/<uuid>")>
const b64url = Buffer.from("dsh:/" + target.u).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const REAL_URI = "ahp-chat://default/" + b64url;
await check(REAL_URI, "★★★ 真身形态 ahp-chat://default/<base64url> → 返回对象且解出 uuid", true);
await check("dsh:/" + target.u, "直给 dsh:/<uuid> → 返回对象", true);
await check("agent-host-dsh:/" + target.u, "带 agent-host-dsh:/ 前缀 → 仍返回对象", true);
await check("dsh:/session-" + target.u, "带 session- 前缀 → 仍返回对象", true);
await check("dsh:/00000000-0000-0000-0000-000000000000", "不存在的 uuid → 仍返回对象（不 undefined）", true);
await check("dsh:/no-uuid-here", "无 uuid 的 uri → 仍返回对象（兜底）", true);

// 真身形态必须能解出 uuid 并定位 project
const mdReal = await base.getChatMetadata(REAL_URI, {}, {}, undefined);
const realUuidOk = mdReal.project && mdReal.project.displayName === target.u;
results.push(realUuidOk);
console.log(`  ${realUuidOk ? "✓" : "✗"} ★★★ 真身形态解出 uuid = ${mdReal.project?.displayName}（期望 ${target.u}）`);
const realMtimeOk = Math.abs(mdReal.modifiedTime - target.mt) < 60000;
results.push(realMtimeOk);
console.log(`  ${realMtimeOk ? "✓" : "✗"} ★★★ 真身形态 modifiedTime 来自真实 session.db mtime（差 ${Math.abs(mdReal.modifiedTime - target.mt)}ms）`);
const chatPreserved = mdReal.chat === REAL_URI;
results.push(chatPreserved);
console.log(`  ${chatPreserved ? "✓" : "✗"} ★ chat 原样保留（可被 Oe 解码）: ${mdReal.chat === REAL_URI}`);

// 4th 参就是 registryFallback 对象本体（调用方传 {registryFallback:{...}} 是内部包装，见 bundle）
const mdFb = await base.getChatMetadata("dsh:/11111111-2222-3333-4444-555555555555", {}, {}, { startTime: 1700000000000, modifiedTime: 1700000000000 });
const fbOk = mdFb.modifiedTime === 1700000000000;
results.push(fbOk);
console.log(`  ${fbOk ? "✓" : "✗"} registryFallback.modifiedTime 被采用（${mdFb.modifiedTime}）`);

// chatContext.workingDirectories 生效
const mdWd = await base.getChatMetadata("dsh:/" + target.u, { workingDirectories: ["file:///x/y"] }, {}, undefined);
const wdOk = Array.isArray(mdWd.workingDirectories) && mdWd.workingDirectories[0] === "file:///x/y";
results.push(wdOk);
console.log(`  ${wdOk ? "✓" : "✗"} chatContext.workingDirectories 被透传`);

// 原生有值时必须原样返回（不覆盖）
const base2 = { async getChatMetadata() { return { chat: "x", native: true }; } };
makeOverride(base2, () => {});
const native = await base2.getChatMetadata("dsh:/whatever", {}, {}, undefined);
const nativeOk = native && native.native === true;
results.push(nativeOk);
console.log(`  ${nativeOk ? "✓" : "✗"} 原生有值时不被覆盖`);

const pass = results.filter(Boolean).length;
console.log(`\n=== ${pass}/${results.length} PASS ===`);
process.exit(pass === results.length ? 0 : 1);
