// 独立测试 ai.jxbw.com 的 API key 是否有效
// 用法：node probe-key.mjs <apiKey> [baseURL] [model]
import { readFileSync } from "node:fs";

const keyArg = process.argv[2];
const baseURL = process.argv[3] || "https://ai.jxbw.com/v1";
const model = process.argv[4] || "Qwen3.8-Flash-AI";

// 若未在命令行给 key，从凭据文件读（不打印明文）
function loadKeyFromCreds(envName) {
  const p = process.env.USERPROFILE + "/.dsh/.credentials.yaml";
  const s = readFileSync(p, "utf8");
  const re = new RegExp("^\\s*" + envName + "\\s*:\\s*(\\S+)\\s*$", "m");
  const m = s.match(re);
  return m ? m[1] : null;
}

const apiKey = keyArg && keyArg !== "-" ? keyArg : loadKeyFromCreds("LOBSTERAI_CUSTOM_0_API_KEY");
if (!apiKey) { console.error("no key"); process.exit(2); }

const mask = apiKey.length > 12 ? apiKey.slice(0, 6) + "***" + apiKey.slice(-4) : "***";
console.log(`[probe] baseURL=${baseURL}  model=${model}  key=${mask}`);

async function tryChat(label, path) {
  const url = baseURL.replace(/\/$/, "") + path;
  const body = {
    model,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 8,
    stream: false,
  };
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    const ms = Date.now() - t0;
    console.log(`\n[${label}] HTTP ${r.status}  (${ms}ms)  ${url}`);
    if (parsed?.error) {
      console.log("  error:", JSON.stringify(parsed.error));
    } else if (parsed?.choices) {
      console.log("  OK  回复:", JSON.stringify(parsed.choices?.[0]?.message?.content));
    } else {
      console.log("  body(前300):", text.slice(0, 300));
    }
    return { status: r.status, parsed };
  } catch (e) {
    console.log(`\n[${label}] 请求异常: ${e.name}: ${e.message}`);
    return { status: 0, error: e };
  }
}

// 1) /chat/completions
await tryChat("POST /chat/completions", "/chat/completions");
// 2) /models 看鉴权是否通过
try {
  const r = await fetch(baseURL.replace(/\/$/, "") + "/models", {
    headers: { Authorization: "Bearer " + apiKey },
    signal: AbortSignal.timeout(20000),
  });
  const t = await r.text();
  console.log(`\n[GET /models] HTTP ${r.status}`);
  console.log("  body(前400):", t.slice(0, 400));
} catch (e) {
  console.log(`\n[GET /models] 异常: ${e.name}: ${e.message}`);
}
