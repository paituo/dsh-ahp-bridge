// audit-tool-demo.mjs — 读取 Agents 窗口消息区的工具演示结果，定位子智能体报错展示
const PORT = process.argv[2] || '9333';
const BASE = `http://127.0.0.1:${PORT}`;
class CDP {
  constructor(u){this.u=u;this.id=0;this.pending=new Map();}
  connect(){return new Promise((res,rej)=>{const ws=new WebSocket(this.u);this.ws=ws;
    ws.onopen=()=>res(this); ws.onerror=e=>rej(new Error('ws '+(e.message||e)));
    ws.onmessage=ev=>{let m;try{m=JSON.parse(ev.data);}catch{return;}
      if(m.id&&this.pending.has(m.id)){this.pending.get(m.id)(m);this.pending.delete(m.id);}};});}
  send(method,params={},timeout=20000){const id=++this.id;return new Promise(resolve=>{
    this.pending.set(id,resolve);this.ws.send(JSON.stringify({id,method,params}));
    setTimeout(()=>{if(this.pending.has(id)){this.pending.delete(id);resolve({__timeout:true});}},timeout);});}
  async eval(expr){const r=await this.send('Runtime.evaluate',{
    expression:`(()=>{try{return (${expr});}catch(e){return {__err:String(e&&e.message||e)};}})()`,
    returnByValue:true,timeout:15000});
    if(r.__timeout)return {__timeout:true};
    if(r.result?.exceptionDetails)return {__err:r.result.exceptionDetails.text};
    return r.result?.result?.value;}
}
(async()=>{
  const list=await (await fetch(`${BASE}/json/list`)).json();
  const page=list.find(t=>t.type==='page'&&/智能体|Agent/i.test(t.title||''))||list.find(t=>t.type==='page');
  if(!page){console.log('NO PAGE');process.exit(2);}
  const c=new CDP(page.webSocketDebuggerUrl); await c.connect(); await c.send('Runtime.enable');
  console.log('PAGE:', page.title);

  // 1) 会话头/当前 provider
  console.log('\n[1] 会话类型选择器:', await c.eval(`(()=>{const el=document.querySelector('[aria-label^="选择会话类型"]');return el?el.getAttribute('aria-label'):null;})()`));

  // 2) 整页文本里所有含"子智能体/task/错误/失败/工具"的段落
  const seg=await c.eval(`(()=>{
    const t=(document.body.innerText||'');
    const lines=t.split('\\n').map(s=>s.trim()).filter(Boolean);
    const hits=lines.filter(l=>/子智能体|subagent|task|工具|错误|失败|error|失败|模型|tool/i.test(l));
    return hits.slice(-60);
  })()`);
  console.log('\n[2] 含工具/子智能体关键字行:');
  if(Array.isArray(seg)) seg.forEach(l=>console.log('   ', l.slice(0,160))); else console.log('   ', seg);

  // 3) 所有 tool 调用卡片（名称 + 状态）
  console.log('\n[3] 工具调用卡片:', await c.eval(`(()=>{
    const out=[];
    document.querySelectorAll('[class*="tool"],[class*="Tool"],[data-tool]').forEach(el=>{
      const t=(el.textContent||'').trim(); if(t&&t.length<120) out.push(t);
    });
    return Array.from(new Set(out)).slice(0,30);
  })()`));
  process.exit(0);
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
