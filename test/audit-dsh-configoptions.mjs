// 真机取证：DSH session/new 回执里到底暴露了哪些 configOptions（除 model 外是否有 preset/agent）
import { spawn } from "node:child_process";

const DSH_BIN = process.argv[2] || "D:/JavaSofewares/npm-cache/dsh";
const CWD = process.argv[3] || "D:/GoProjects/bowei-agent-work";

class JsonRpc {
  constructor(child) {
    this.child = child; this.id = 0; this.pending = new Map(); this.buf = "";
    child.stdout.on("data", (d) => {
      this.buf += d.toString();
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); }
      }
    });
    child.stderr.on("data", (d) => { if (process.env.VERBOSE) process.stderr.write("[dsh] " + d); });
  }
  request(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, (m) => (m.error ? rej(new Error(method + ": " + JSON.stringify(m.error))) : res(m.result)));
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(method + ": timeout")); } }, 30000);
    });
  }
}

(async () => {
  console.log("=== 启动 DSH ACP ===");
  const child = spawn("node", [DSH_BIN, "--profile", "acp"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
  const rpc = new JsonRpc(child);
  const init = await rpc.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    clientInfo: { name: "audit", version: "0.1.0" },
  });
  console.log("initialize ok:", JSON.stringify(init).slice(0, 300));

  const sess = await rpc.request("session/new", { cwd: CWD, mcpServers: [] });
  console.log("\n=== session/new 回执 keys:", Object.keys(sess));
  console.log("sessionId:", sess.sessionId);

  const co = sess.configOptions ?? sess.config_options;
  console.log("\n=== configOptions 原始 ===");
  console.log(JSON.stringify(co, null, 2).slice(0, 3000));

  if (Array.isArray(co)) {
    console.log("\n=== 各 option 的 id / category ===");
    for (const o of co) {
      const cat = o.category ?? "(no category)";
      const vals = (o.options ?? o.values ?? []);
      const cnt = Array.isArray(vals) ? vals.length : Object.keys(vals || {}).length;
      console.log(`  id=${o.id}  name=${o.name}  category=${cat}  type=${o.type}  选项数=${cnt}`);
    }
    const nonModel = co.filter((o) => o.category !== "model" && o.id !== "model");
    console.log("\n=== 非 model 的 configOption（可能承载 agent/preset）===");
    console.log(JSON.stringify(nonModel, null, 2).slice(0, 2000));
  }

  child.kill();
  process.exit(0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
