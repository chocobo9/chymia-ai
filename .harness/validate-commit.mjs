#!/usr/bin/env node
// .harness/validate-commit.mjs — 对齐证据闸（闸一）
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const REFERENCE_ROOT = 'reference/clowder-ai-main';
const GUARDED_PREFIX = 'packages/';
const MIN_REASON = 15;

function fail(lines) {
  console.error('\n\x1b[31m✗ 对齐证据闸 (commit-msg) 拒绝本次提交\x1b[0m');
  for (const l of lines) console.error('  ' + l);
  console.error('\n  本次 commit 触碰了 packages/** 产品代码，必须出示可验证的对齐证据。');
  console.error('  范例 trailer（贴在 commit message 末尾）：');
  console.error('    Aligned-To: reference/clowder-ai-main/packages/web/src/components/audit/AuditEventsTab.tsx');
  console.error('    Symptom-Repro: tests/web/status-bar-tabs.edge.test.tsx::[happy] audit row expands');
  console.error('    Scope-Verified: audit-row-expand=yes, session-row-expand=yes, search-tab=inherits');
  console.error('\n  确需绕过（人的显式决定）：git commit --no-verify\n');
  process.exit(1);
}
function git(args) { return execFileSync('git', args, { encoding: 'utf8' }).trim(); }

let root;
try { root = git(['rev-parse', '--show-toplevel']); } catch { fail(['无法定位 git repo 根。']); }

// 两种模式：
//   hook 模式（默认）：argv[2]=commit-msg 文件，改动取自暂存区。
//   CI 模式（--ci）：消息+改动取自 HEAD 提交，绕不过 --no-verify。
const ciMode = process.argv.includes('--ci');
let raw, changed;
if (ciMode) {
  raw = git(['log', '-1', '--pretty=%B']).replace(/\r/g, '');
  let range; try { git(['rev-parse', 'HEAD~1']); range = ['HEAD~1', 'HEAD']; }
  catch { range = ['HEAD']; } // 首次提交无父
  changed = git(['diff', '--name-only', '--diff-filter=ACM', ...range])
    .split('\n').map((s) => s.trim()).filter(Boolean);
} else {
  const msgPath = process.argv[2];
  if (!msgPath) fail(['没有收到 commit message 路径。']);
  raw = readFileSync(msgPath, 'utf8').replace(/\r/g, '');
  changed = git(['diff', '--cached', '--name-only', '--diff-filter=ACM'])
    .split('\n').map((s) => s.trim()).filter(Boolean);
}
const firstLine = raw.split('\n').find((l) => l.trim().length > 0) ?? '';
if (/^(Merge|Revert)\b/.test(firstLine)) process.exit(0);
if (!changed.some((f) => f.startsWith(GUARDED_PREFIX))) process.exit(0);

function trailer(key) {
  const m = raw.match(new RegExp(`^${key}:\\s*(.+)$`, 'im'));
  return m ? m[1].trim() : null;
}
const errors = [];

const alignedTo = trailer('Aligned-To');
if (!alignedTo) errors.push('缺 Aligned-To: 没有指明对齐的 Clowder 对应物。');
else if (/^NONE\b/i.test(alignedTo)) {
  const reason = alignedTo.replace(/^NONE\b/i, '').replace(/^[\s\-—]+/, '').trim();
  if (reason.length < MIN_REASON) errors.push(`Aligned-To: NONE 必须附理由（≥${MIN_REASON}字）。当前："${reason}"`);
} else {
  for (const p of alignedTo.split(/[,\s]+/).filter(Boolean)) {
    if (!p.startsWith(REFERENCE_ROOT)) { errors.push(`Aligned-To 路径必须在 ${REFERENCE_ROOT}/ 下：${p}`); continue; }
    let ok = false; try { ok = statSync(resolve(root, p)).isFile(); } catch { ok = false; }
    if (!ok) errors.push(`Aligned-To 指向的 Clowder 文件不存在（编不出来）：${p}`);
  }
}

const repro = trailer('Symptom-Repro');
if (!repro) errors.push('缺 Symptom-Repro: 没有指明复现该症状的测试。');
else if (/^NONE\b/i.test(repro)) {
  const reason = repro.replace(/^NONE\b/i, '').replace(/^[\s\-—]+/, '').trim();
  if (reason.length < MIN_REASON) errors.push(`Symptom-Repro: NONE 必须附理由（≥${MIN_REASON}字）。当前："${reason}"`);
} else {
  const idx = repro.indexOf('::');
  if (idx < 0) errors.push(`Symptom-Repro 格式应为 <测试文件>::<测试名子串>：${repro}`);
  else {
    const file = repro.slice(0, idx).trim(); const needle = repro.slice(idx + 2).trim();
    let content = null; try { content = readFileSync(resolve(root, file), 'utf8'); } catch {}
    if (content === null) errors.push(`Symptom-Repro 测试文件不存在：${file}`);
    else if (!needle) errors.push('Symptom-Repro 缺测试名子串。');
    else if (!content.includes(needle)) errors.push(`Symptom-Repro 在 ${file} 找不到测试名子串："${needle}"。`);
  }
}

const scope = trailer('Scope-Verified');
if (!scope) errors.push('缺 Scope-Verified: 没有逐项核验范围。');
else if (!/[^\s=]+=[^\s,]+/.test(scope)) errors.push(`Scope-Verified 必须含至少一个 key=value：${scope}`);

if (errors.length > 0) fail(errors);
process.exit(0);
