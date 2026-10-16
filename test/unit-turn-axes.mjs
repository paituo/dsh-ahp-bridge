/**
 * 单测：三轴权限解析（vs 官方 codexSessionConfigKeys.ts 权威表）
 *
 * 权威表（逐字取自 microsoft/vscode@6d62b1d5da
 *   src/vs/platform/agentHost/common/codexSessionConfigKeys.ts::resolveCodexPermissionsPreset）：
 *   default     → { on-request, workspace-write,    user }
 *   auto-review → { on-request, workspace-write,    auto_review }
 *   full-access → { never,      danger-full-access, user }
 *   交互：VS Code "Plan"→codex `plan`；"Interactive"→codex `default`
 */
import { resolveTurnPermissionAxes, reviewerToDshHint, CODEX_PRESET_TO_AXES } from '../src/permission-mode.mjs';

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + '\n      got  = ' + JSON.stringify(got) + '\n      want = ' + JSON.stringify(want)); }
};

console.log('§1 预设三档 → 三轴（对齐官方表）');
eq('default ⇒ workspace-write + ask + user',
  { s: resolveTurnPermissionAxes({ permissions: 'default' }).sandboxMode,
    a: resolveTurnPermissionAxes({ permissions: 'default' }).approval,
    r: resolveTurnPermissionAxes({ permissions: 'default' }).reviewer },
  { s: 'workspace-write', a: 'ask', r: 'user' });
eq('auto-review ⇒ workspace-write + ask + auto_review',
  { s: resolveTurnPermissionAxes({ permissions: 'auto-review' }).sandboxMode,
    a: resolveTurnPermissionAxes({ permissions: 'auto-review' }).approval,
    r: resolveTurnPermissionAxes({ permissions: 'auto-review' }).reviewer },
  { s: 'workspace-write', a: 'ask', r: 'auto_review' });
eq('full-access ⇒ danger-full-access + never + user',
  { s: resolveTurnPermissionAxes({ permissions: 'full-access' }).sandboxMode,
    a: resolveTurnPermissionAxes({ permissions: 'full-access' }).approval,
    r: resolveTurnPermissionAxes({ permissions: 'full-access' }).reviewer },
  { s: 'danger-full-access', a: 'never', r: 'user' });

console.log('§2 兼容形态（profile: 前缀 / 大小写）');
eq('profile:auto-review 亦可识别', resolveTurnPermissionAxes({ permissions: 'profile:auto-review' }).reviewer, 'auto_review');
eq('FULL-ACCESS 大小写归一', resolveTurnPermissionAxes({ permissions: 'FULL-ACCESS' }).sandboxMode, 'danger-full-access');

console.log('§3 legacy 单轴');
eq('approvalPolicy=never ⇒ approval never', resolveTurnPermissionAxes({ approvalPolicy: 'never' }).approval, 'never');
eq('approvalPolicy=on-request ⇒ ask', resolveTurnPermissionAxes({ approvalPolicy: 'on-request' }).approval, 'ask');
eq('approvalPolicy=untrusted ⇒ ask（DSH 无三档，归"要问"）', resolveTurnPermissionAxes({ approvalPolicy: 'untrusted' }).approval, 'ask');
eq('sandboxMode 直通 read-only', resolveTurnPermissionAxes({ sandboxMode: 'read-only' }).sandboxMode, 'read-only');
eq('sandbox:{type} 直通', resolveTurnPermissionAxes({ sandbox: { type: 'danger-full-access' } }).sandboxMode, 'danger-full-access');
eq('approvalsReviewer=guardian_subagent', resolveTurnPermissionAxes({ approvalsReviewer: 'guardian_subagent' }).reviewer, 'guardian_subagent');

console.log('§4 直接 sandbox 覆盖预设');
eq('preset=default + sandboxMode=read-only ⇒ read-only（sandbox 优先）',
  resolveTurnPermissionAxes({ permissions: 'default', sandboxMode: 'read-only' }).sandboxMode, 'read-only');

console.log('§5 交互方式');
eq('collaborationMode.mode=plan', resolveTurnPermissionAxes({ collaborationMode: { mode: 'plan' } }).interactionMode, 'plan');
eq('collaborationMode.mode=default', resolveTurnPermissionAxes({ collaborationMode: { mode: 'default' } }).interactionMode, 'default');
eq('collaborationMode 字符串形态', resolveTurnPermissionAxes({ collaborationMode: 'plan' }).interactionMode, 'plan');

console.log('§6 无信号 ⇒ 全 null（宁可不动，也不猜）');
eq('空参 ⇒ 全 null', resolveTurnPermissionAxes({}),
  { sandboxMode: null, approval: null, reviewer: null, interactionMode: null, source: 'none' });
eq('非法预设不误判', resolveTurnPermissionAxes({ permissions: 'wat' }).sandboxMode, null);
eq('非法 sandbox 不误判', resolveTurnPermissionAxes({ sandboxMode: 'root' }).sandboxMode, null);

console.log('§7 reviewer → DSH 提示');
eq('auto_review ⇒ autoReview:true', reviewerToDshHint('auto_review'), { autoReview: true });
eq('user ⇒ autoReview:false', reviewerToDshHint('user'), { autoReview: false });
eq('未知 ⇒ null', reviewerToDshHint('x'), null);

console.log('§8 三轴来源标记');
eq('预设来源', resolveTurnPermissionAxes({ permissions: 'default' }).source, 'preset:default');
eq('预设+沙箱来源', resolveTurnPermissionAxes({ permissions: 'default', sandboxMode: 'read-only' }).source, 'preset:default+sandbox');

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail === 0 ? 0 : 1);
