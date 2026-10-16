// 关键验证：同一个 jxbw key 分别打「ai.jxbw.com」和「api.deepseek.com」，看错误文案归属
import { readFileSync } from "node:fs";

const p = process.env.USERPROFILE + "/.dsh/.credentials.yaml";
const s = readFileSync(p, "utf8");
const m = s.match(/^\s*LOBSTERAI_CUSTOM_0_API_KEY\s*:\s*(\S+)\s*$/m);
const apiKey = m[1];
const mask = apiKey.slice(0, 6) + "***" + apiKey.slice(-4);
console.log(`[probe] key=${mask}\n`);

async function tryURL(label, url, model) {
  const body = { model, messages: [{ role: "user", content: "ping" }], max_tokens: 8, stream: false };
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    const ms = Date.now() - t0;
    console.log(`[${label}] HTTP ${r.status} (${ms}ms)`);
    console.log(`  url: ${url}`);
    console.log(`  body: ${text.slice(0, 400)}\n`);
  } catch (e) {
    console.log(`[${label}] 异常: ${e.name}: ${e.message}\n`);
  }
}

// 1) 自建网关（已知可用）
await tryURL("jxbw 网关", "https://ai.jxbw.com/v1/chat/completions", "Qwen3.8-Flash-AI");
// 2) DeepSeek 官方（验证错误文案归属）
await tryURL("DeepSeek 官方", "https://api.deepseek.com/v1/chat/completions", "deepseek-chat");
await tryURL("DeepSeek 官方(chat)", "https://api.deepseek.com/chat/completions", "deepseek-chat");
