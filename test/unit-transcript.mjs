import { cwdToSessionDirKey, readTranscript, extractConversationEvents, extractSessionTitle, findTranscriptBySessionId } from '../src/transcript.mjs';

// ① 目录名转义自检（注意：盘符大小写取决于创建时会话的 cwd，第三条以小写 c: 创建）
const cases = [
  ['C:\\Users\\liuyue', '--C-Users-liuyue--'],
  ['E:\\分析数据\\DeepSeek-Harness-VSCode\\dev', '--E-~5206~6790~6570~636E-DeepSeek-Harness-VSCode-dev--'],
];
let pass = 0, fail = 0;
for (const [inp, want] of cases) {
  const got = cwdToSessionDirKey(inp);
  const ok = got === want;
  console.log((ok ? 'OK  ' : 'FAIL') + ' ' + JSON.stringify(inp));
  if (!ok) { console.log('  got =' + got); console.log('  want=' + want); }
  ok ? pass++ : fail++;
}

// ② 真实转录读取（有 cwd）
const sid = '8b2ba05a-c8ef-477a-8ad4-1d9287920408';
const cwd = 'E:/分析数据/DeepSeek-Harness-VSCode/dev';
const { records, path: p, error } = await readTranscript(sid, cwd);
console.log('\n[读取-带cwd] path=' + p);
console.log('  records=' + records.length + ' error=' + error);
const { events } = extractConversationEvents(records);
console.log('[事件] ' + events.length + ' 条:');
events.forEach(e => console.log('  ' + e.kind.padEnd(9) + ' turn=' + String(e.turn).padEnd(3) + ' ' + JSON.stringify(e.text.slice(0, 60))));
console.log('[标题] ' + JSON.stringify(extractSessionTitle(records, events)));

// ③ 无 cwd ⇒ 全局反查兜底
const r2 = await readTranscript(sid, null);
console.log('\n[读取-无cwd] path=' + r2.path + ' records=' + r2.records.length);
if (r2.records.length > 0) pass++; else { console.log('  FAIL 无 cwd 未兜底'); fail++; }

// ④ 小写盘符目录（大小写不敏感兜底）
const lowerSid = 'ccb9edb2-daee-4b3e-912e-0b098f3a50eb';   // 会话目录为 --c- 小写盘符
const r3 = await readTranscript(lowerSid, 'C:\\Users\\liuyue\\AppData\\Roaming\\Code\\agentSessionData\\1649d8dd-3358-4238-ba7d-b752d8bbd35b');
console.log('\n[读取-小写盘符] path=' + r3.path + ' records=' + r3.records.length);

console.log('\n测试: 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
