// 验收 Fix#1：readSessionTimestampIndex 能否补齐真实时间戳
import { readSessionTimestampIndex } from '../src/discovery.mjs';
const idx = await readSessionTimestampIndex({});
console.log('索引条数:', idx.size);
const uniqCreated = new Set([...idx.values()].map(v => Math.floor(v.createdAtMs / 1000)));
console.log('createdAt(秒) 唯一值数:', uniqCreated.size, idx.size > 1 && uniqCreated.size > 1 ? '✅ 已分化' : '❌ 仍相同');
const sample = [...idx.entries()].slice(0, 5);
for (const [k, v] of sample) {
  console.log(' ', k.slice(0, 12), '| created:', new Date(v.createdAtMs).toISOString(), '| updated:', new Date(v.updatedAtMs).toISOString());
}
// 断言：截图里那条会话必须能查到，且创建时间 = 23:14 左右（实测 15:14Z）
const target = idx.get('ccb9edb2-daee-4b3e-912e-0b098f3a50eb');
console.log('\n目标会话 ccb9edb2:', target ? new Date(target.createdAtMs).toISOString() : '❌ 未找到');
