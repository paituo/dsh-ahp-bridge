#!/usr/bin/env node
/**
 * 打开「会话类型」picker（输入区第一个 picker，当前显示"本地"），
 * 用真实鼠标事件点选 "DSH (DeepSeek Harness)"，建立 DSH 会话。
 * 之后 agent picker 才会以 agenthost-dsh 为 scheme 提供 preset。
 */
const PORT = process.argv[2] || "9333";
const WANT_TYPE = process.argv[3] || "DSH";

function connect(wsUrl) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pend = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data.toString()); if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    ws.onopen = () => resolve({
      ws,
      send: (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }),
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXPR_ALL = "(() => {"
  + "const a=[...document.querySelectorAll('a.action-label[aria-haspopup=\"true\"]')];"
  + "return JSON.stringify(a.map((e,i)=>({i,label:e.getAttribute('aria-label')||'',text:(e.textContent||'').trim().slice(0,40),cls:e.className.slice(0,60),r:(()=>{const b=e.getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2),w:Math.round(b.width)};})()})));"
  + "})()";

const EXPR_MENUITEMS = "(() => {"
  + "const out=[];"
  + "const sels=['.monaco-list-row','[role=\"menuitemcheckbox\"]','[role=\"menuitem\"]','.action-widget .action-item','.quick-input-list .monaco-list-row'];"
  + "for(const s of sels){document.querySelectorAll(s).forEach(el=>{const t=(el.textContent||'').trim();if(t&&t.length<70){const b=el.getBoundingClientRect();if(b.width>0&&b.height>0)out.push({s,text:t,x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)});}});if(out.length)break;}"
  + "return JSON.stringify(out.slice(0,30));"
  + "})()";

(async () => {
  const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
  const pg = list.filter((p) => p.type === "page").find((p) => /^Agent/i.test(p.title || "")) || list.find((p) => p.type === "page");
  const { ws, send } = await connect(pg.webSocketDebuggerUrl);
  await send("Runtime.enable");
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };
  const mouse = async (type, x, y, cc = 0) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: cc, buttons: type === "mousePressed" ? 1 : 0 });

  // 找显示"本地"的会话类型 picker
  const all = JSON.parse(await ev(EXPR_ALL));
  const typeP = all.find((p) => /^本地$/.test(p.text) || /本地/.test(p.text));
  if (!typeP) { console.log("❌ 没找到会话类型 picker（本地）", JSON.stringify(all.map(a => a.text))); ws.close(); process.exit(1); }
  console.log('✅ 会话类型 picker: "' + typeP.text + '" @(' + typeP.r.x + "," + typeP.r.y + ")");

  await mouse("mouseMoved", typeP.r.x, typeP.r.y);
  await mouse("mousePressed", typeP.r.x, typeP.r.y, 1);
  await mouse("mouseReleased", typeP.r.x, typeP.r.y, 1);
  await sleep(900);

  const items = JSON.parse(await ev(EXPR_MENUITEMS));
  console.log("类型菜单项:", JSON.stringify(items.map((i) => i.text)));

  const tgt = items.find((i) => i.text.includes(WANT_TYPE));
  if (!tgt) { console.log('❌ 类型菜单里没有 "' + WANT_TYPE + '"'); ws.close(); process.exit(1); }
  console.log('🎯 选择类型: "' + tgt.text + '" @(' + tgt.x + "," + tgt.y + ")");

  await mouse("mouseMoved", tgt.x, tgt.y);
  await mouse("mousePressed", tgt.x, tgt.y, 1);
  await mouse("mouseReleased", tgt.x, tgt.y, 1);
  await sleep(3000);

  const after = JSON.parse(await ev(EXPR_ALL));
  console.log("\n选择后 pickers:", JSON.stringify(after.map((a) => a.text).filter(Boolean)));
  ws.close();
  process.exit(0);
})();
