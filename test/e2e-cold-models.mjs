#!/usr/bin/env node
/**
 * 回归测试 —— 冷启动「0 模型 ⇒ 回退 Auto ⇒ bridge timeout: thread/start」缺陷。
 *
 * 复现的原始故障链（VS Code 现场日志 2026-10-10 23:56~00:10 实证）：
 *   1) 桥刚起，VS Code 未 thread/start 就直接 model/list
 *      ⇒ 旧实现只遍历 state.byThread ⇒ 返回 {models:[]}
 *      ⇒ VS Code "Found 0 models" → "No models listed; offering Auto"
 *   2) 用户用了一个 DSH 不认识的模型 → 后续 turn/start 通道失配
 *      ⇒ 桥→DSH 通道已断 ⇒ 请求永久 pending ⇒ 等满 120s
 *      ⇒ UI 显示 "(sendFailed) bridge timeout: thread/start"
 *
 * 本测试断言修复后：
 *   B1 冷启动（不 thread/start）直接 model/list ⇒ 模型非空（修复前必然 0）
 *   B2 模型清单包含两个自定义模型（Qwen3.8-Flash-AI / deepseek-v4.1-flash）
 *   B3 initialize 后桥主动预热 bootstrap ⇒ 第一次 model/list 即命中（非惰性空转）
 *   B4 thread/start 仍正常（bootstrap 未占坏 byThread 语义）
 *   B5 DSH 子进程被杀后，turn/start 快速报明确错误（不挂 120s）
 *   B6 子进程被杀后，model/list 仍能自愈返回非空（重建通道 + 重建 bootstrap）
 *
 * 运行：node test/e2e-cold-models.mjs
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, "..", "src", "bridge.mjs");
const NODE = process.env.BRIDGE_NODE || process.execPath;
const DSH_BIN = process.env.DSH_BIN || "D:/JavaSofewares/npm-cache/node_modules/@deepseek-ai/dsh/lib/bin.js";
const CWD = process.env.BRIDGE_CWD || "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`PASS  ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`); }
};

class Ctx {
  constructor(child) {
    this.child = child; this.buf = ""; this.id = 1; this.pending = new Map();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      this.buf += d; let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
          const p = this.pending.get(m.id);
          if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(`${m.error.code}: ${m.error.message}`)) : p.resolve(m.result); }
        }
      }
    });
  }
  request(method, params, timeoutMs = 30000) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`timeout: ${method}`)); }, timeoutMs);
    });
  }
}

function launch() {
  const child = spawn(NODE, [BRIDGE, "--node", NODE, "--dsh-bin", DSH_BIN, "--cwd", CWD, "--provider-id", "dsh", "--profile", "acp"], {
    cwd: CWD, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  child.stderr.setEncoding("utf8");
  if (process.env.VERBOSE) child.stderr.on("data", (d) => process.stderr.write(`[b] ${d}`));
  return { child, ctx: new Ctx(child) };
}

/** 找到桥 spawn 的 dsh 子进程 pid（用于强杀测试）——用 WMI via PowerShell（wmic 已在 Win11 移除） */
function findDshChild(bridgePid) {
  const { execSync } = require("node:child_process");
  try {
    const out = execSync(
      `powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ParentProcessId=${bridgePid}' | Where-Object { $_.CommandLine -match 'bin\\.js' } | Select-Object -ExpandProperty ProcessId"`,
      { encoding: "utf8", windowsHide: true, timeout: 20000 },
    );
    const pid = Number(String(out).trim().split(/\s+/).filter(Boolean)[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

async function main() {
  console.log("=== 冷启动模型缺陷回归测试 ===");
  console.log(`bridge: ${BRIDGE}\n`);

  const { child, ctx } = launch();

  try {
    // B3: initialize
    const init = await ctx.request("initialize", { clientInfo: { name: "cold", version: "0" }, capabilities: {} });
    check("B3 initialize 握手", !!init?.serverInfo, JSON.stringify(init?.serverInfo));

    // B1: 冷启动直接 model/list（不 thread/start）—— 修复前这里必然是 0
    const m0 = await ctx.request("model/list", {});
    const n0 = m0?.models?.length ?? 0;
    check("B1 冷启动 model/list 非空（修复前为 0）", n0 > 0, `models=${n0} [${(m0?.models ?? []).map((x) => x.id).join(", ")}]`);

    // B2: 两个自定义模型在场（与 VS Code 名称一致）
    const ids = new Set((m0?.models ?? []).map((x) => x.id));
    const hasQwen = [...ids].some((i) => /Qwen3\.8-Flash-AI/.test(i));
    const hasBumen = [...ids].some((i) => /deepseek-v4\.1-flash/.test(i));
    check("B2 含 Qwen3.8-Flash-AI", hasQwen, [...ids].find((i) => /Qwen/.test(i)) ?? "缺失");
    check("B2 含 deepseek-v4.1-flash", hasBumen, [...ids].find((i) => /v4\.1/.test(i)) ?? "缺失");

    // B4: thread/start 语义未被 bootstrap 破坏
    const st = await ctx.request("thread/start", { cwd: CWD, mcpServers: [] });
    check("B4 thread/start 正常返回 threadId+models", !!st?.threadId && (st?.models?.length ?? 0) > 0,
      `threadId=${st?.threadId} models=${st?.models?.length ?? 0}`);

    // B4b: 有 thread 后 model/list 仍一致非空
    const m1 = await ctx.request("model/list", {});
    check("B4b 有 thread 后 model/list 仍非空且不重复", (m1?.models?.length ?? 0) === n0,
      `before=${n0} after=${m1?.models?.length ?? 0}`);

    // B5/B6: 强杀 DSH 子进程 → 验证自愈
    const dshPid = findDshChild(child.pid);
    if (!dshPid) {
      check("B5 强杀 DSH 子进程（前置）", false, "未找到 dsh 子进程 pid");
      check("B6 死后 model/list 自愈", false, "skipped");
    } else {
      console.log(`      killing dsh child pid=${dshPid}`);
      try { process.kill(dshPid, "SIGKILL"); } catch (e) { console.log(`      kill err ${e.message}`); }
      await new Promise((r) => setTimeout(r, 1500));

      // B5: 死后 turn/start 必须**快速**失败（<10s），而不是挂满 120s
      const t0 = Date.now();
      let b5ok = false, b5detail = "";
      try {
        await ctx.request("turn/start", { threadId: "nonexistent-thread", input: [{ type: "text", text: "hi" }] }, 15000);
        b5detail = "竟然成功了";
      } catch (e) {
        const dt = Date.now() - t0;
        b5ok = dt < 10000 && /unavailable|unknown thread|aborted|exited|timeout/i.test(e.message);
        b5detail = `${dt}ms — ${e.message}`;
      }
      check("B5 通道死后 turn/start 快速明确报错（非挂满 120s）", b5ok, b5detail);

      // B6: 死后 model/list 自愈（重建通道 + 重建 bootstrap）
      let m2 = null;
      try { m2 = await ctx.request("model/list", {}, 40000); } catch (e) { console.log(`      model/list err: ${e.message}`); }
      check("B6 通道死后 model/list 自愈返回非空", (m2?.models?.length ?? 0) > 0, `models=${m2?.models?.length ?? 0}`);
    }
  } catch (e) {
    check("主流程异常", false, e?.stack ?? String(e));
  } finally {
    try { child.stdin.end(); } catch {}
    await new Promise((r) => setTimeout(r, 500));
    try { child.kill(); } catch {}
  }

  console.log(`\n=== 结果：${pass}/${pass + fail} PASS ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
