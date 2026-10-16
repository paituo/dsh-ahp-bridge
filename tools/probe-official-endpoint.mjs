/**
 * 只读探针：验证 DSH `deepseek-official` provider 的实际端点行为。
 *
 * 【目的】真机报 403 `access_denied / 您的 IP 不在令牌允许访问的列表中 / new_api_error`
 *   时，判定该报错归属哪个 baseURL：
 *     · `api.deepseek.com/anthropic` → 英文 `authentication_error`（401）
 *     · jxbw 网关（New API）        → 中文 `new_api_error` + IP 白名单（403）
 *
 * 【用法】node probe-official-endpoint.mjs
 * 【性质】纯只读：只发 JSON-RPC，不写任何 DSH 状态。
 */
import { spawn } from "node:child_process";

const NODE = process.env.DSH_NODE_EXE
  ?? "E:/分析数据/DeepSeek-Harness-VSCode/runtime/node/node.exe";
const BIN = process.env.DSH_BIN
  ?? "E:/分析数据/DeepSeek-Harness-VSCode/dev/dsh/lib/bin.js";
const CWD = process.env.DSH_PROBE_CWD
  ?? "E:/分析数据/DeepSeek-Harness-VSCode/dev";

const p = spawn(NODE, [BIN, "--profile", "acp"], {
  cwd: CWD,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
p.stderr.on("data", (d) => process.stderr.write("[dsh] " + d));
p.on("exit", (c) => console.log(`[dsh 退出 code=${c}]`));

const send = (o) => p.stdin.write(JSON.stringify(o) + "\n");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pending = new Map();
let raw = "";
p.stdout.on("data", (d) => {
  raw += d;
  for (const line of d.toString().split("\n")) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (j.id !== undefined && pending.has(j.id)) {
        pending.get(j.id)(j);
        pending.delete(j.id);
      }
    } catch { /* 非 JSON 行 */ }
  }
});
const rpc = (id, method, params) =>
  new Promise((res) => {
    pending.set(id, res);
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => pending.has(id) && (pending.delete(id), res({ timeout: true })), 40000);
  });

const pick = (sid, provider, model) =>
  rpc(9, "session/set_config_option", { sessionId: sid, configId: "model", value: JSON.stringify([provider, model]) });

(async () => {
  await rpc(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
  const sn = await rpc(2, "session/new", { cwd: CWD, mcpServers: [] });
  const sid = sn?.result?.sessionId;
  if (!sid) { console.error("session/new 失败:", JSON.stringify(sn).slice(0, 400)); p.kill(); process.exit(1); }
  console.log("sessionId =", sid);
  console.log("DSH 默认 currentModel =", sn.result.configOptions?.[0]?.currentValue);

  for (const [prov, mdl] of [["deepseek-official", "deepseek-flash"], ["bumen", "deepseek-v4.1-flash"]]) {
    const setR = await pick(sid, prov, mdl);
    console.log(`\n=== set model = ${JSON.stringify([prov, mdl])} ===`);
    console.log("  回执:", JSON.stringify(setR).slice(0, 250));
    const pr = await rpc(10, "session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "说一个字：好" }] });
    console.log("  prompt 回执:", JSON.stringify(pr).slice(0, 600));
  }
  p.kill();
  process.exit(0);
})();
