#!/usr/bin/env node
// .harness/check-alignment.mjs — PreToolUse 早闸
//
// Claude Code 在每次 Write/Edit/MultiEdit 之前调用本脚本（见 .claude/settings.json）。
// stdin 收到 PreToolUse payload（JSON）：{ session_id, cwd, tool_name, tool_input{file_path,...} }。
// 规则：要写 packages/** 产品代码，必须先存在「本 session 的对齐声明」且其中 Aligned-To
// 指向 reference/clowder-ai-main/ 下真实存在的文件——逼它读了 Clowder 再动代码。
//
// 退出码：0=放行；2=拦截（Claude Code 取消本次写入，并把 stderr 回喂模型让它改道）。
// 故意 fail-open（解析不了 / 非 git / 非 packages 一律放行）：宁可漏拦也不把 agent 卡死，
// commit 闸（validate-commit.mjs）在交付时兜底。本闸只负责"动手前先读"这一件事。

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve, posix } from 'node:path';

const REFERENCE_ROOT = 'reference/clowder-ai-main';
const GUARDED_PREFIX = 'packages/';
const MIN_REASON = 15;

// --- 读 PreToolUse payload ---
let payload;
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0); // 解析失败 → 放行（commit 闸兜底）
}

const toolInput = payload.tool_input ?? {};
const filePath = toolInput.file_path ?? toolInput.path ?? null;
if (!filePath) process.exit(0); // 拿不到目标路径 → 放行

const cwd = payload.cwd ?? process.cwd();
let root;
try {
  root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
} catch {
  process.exit(0); // 不在 git 仓 → 不管
}

// --- 跨平台归一：反斜杠→正斜杠，统一用 posix 运算（Windows 的 D:\ 路径也适用）---
const norm = (p) => p.replace(/\\/g, '/');
const rootN = norm(root);
const fileN = norm(filePath);
const absFile = fileN.startsWith('/') || /^[A-Za-z]:/.test(fileN)
  ? fileN
  : posix.join(norm(cwd), fileN);
const rel = posix.relative(rootN, absFile);

if (!rel.startsWith(GUARDED_PREFIX)) process.exit(0); // 没碰产品代码（含写声明文件本身、写测试）→ 放行

// --- 命中 packages/**：必须已有本 session 的对齐声明 ---
const sessionId = String(payload.session_id ?? 'nosession').replace(/[^A-Za-z0-9_.-]/g, '_');
const declPath = resolve(root, '.harness/alignment', sessionId + '.md');

function block(msg) {
  process.stderr.write('\n[对齐早闸] 拒绝写入 ' + rel + '\n' + msg + '\n');
  process.exit(2);
}

let decl;
try {
  decl = readFileSync(declPath, 'utf8').replace(/\r/g, '');
} catch {
  block(
    '动 packages/** 产品代码之前，必须先读 Clowder 对应实现并写下对齐声明。\n' +
    '步骤：\n' +
    '  1) cat 出你要对齐的 ' + REFERENCE_ROOT + ' 里的真实文件，证明你读了；\n' +
    '  2) 写 .harness/alignment/' + sessionId + '.md，至少一行：\n' +
    '       Aligned-To: ' + REFERENCE_ROOT + '/<那个真实文件路径>\n' +
    '     （确无对应物时：Aligned-To: NONE -- <理由≥' + MIN_REASON + '字>）\n' +
    '  3) 再来写代码。',
  );
}

const m = decl.match(/^Aligned-To:\s*(.+)$/im);
if (!m) block('对齐声明缺 Aligned-To 行：' + declPath);
const val = m[1].trim();

if (/^NONE\b/i.test(val)) {
  const reason = val.replace(/^NONE\b/i, '').replace(/^[\s\-—]+/, '').trim();
  if (reason.length < MIN_REASON) {
    block('Aligned-To: NONE 必须附理由（≥' + MIN_REASON + '字），说明为何此改动在 Clowder 无对应物。');
  }
} else {
  for (const p of val.split(/[,\s]+/).filter(Boolean)) {
    if (!p.startsWith(REFERENCE_ROOT)) block('Aligned-To 路径必须在 ' + REFERENCE_ROOT + '/ 下：' + p);
    let ok = false;
    try { ok = statSync(resolve(root, p)).isFile(); } catch { ok = false; }
    if (!ok) block('Aligned-To 指向的 Clowder 文件不存在（编不出来）：' + p);
  }
}

process.exit(0); // 声明齐全且对齐目标真实 → 放行
