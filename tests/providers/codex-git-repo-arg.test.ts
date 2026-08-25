// tests/providers/codex-git-repo-arg.test.ts
// P0-2: codex 受信目录门单测 —— 非 git cwd 必须补 --skip-git-repo-check。
// codex 0.137 在非 git/非受信目录拒跑（exit 1: "Not inside a trusted directory and
// --skip-git-repo-check was not specified"）；三 provider 端到端真 CLI smoke 中
// codex 在 mkdtemp 非 git cwd 下 98ms 失败即此门触发。对齐 Clowder
// CodexAgentService.buildGitRepoArgs。真 fs fixture，无 mock。

import { describe, test, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArgs, isGitRepositoryPath } from '@choco/api/providers/codex/codex-service';

describe('codex buildArgs — git repo trust gate (--skip-git-repo-check)', () => {
  test('non-git cwd → buildArgs includes --skip-git-repo-check', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'codex-nogit-'));
    const args = buildArgs({ workingDirectory: cwd }, '');
    expect(args).toContain('--skip-git-repo-check');
  });

  test('git cwd (.git present) → buildArgs omits --skip-git-repo-check', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'codex-git-'));
    mkdirSync(join(cwd, '.git'));
    const args = buildArgs({ workingDirectory: cwd }, '');
    expect(args).not.toContain('--skip-git-repo-check');
  });

  test('isGitRepositoryPath finds .git in an ancestor directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-gitroot-'));
    mkdirSync(join(root, '.git'));
    const nested = join(root, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    expect(isGitRepositoryPath(nested)).toBe(true);
  });

  test('isGitRepositoryPath returns false when no .git up to filesystem root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-nogit-deep-'));
    const nested = join(dir, 'x', 'y');
    mkdirSync(nested, { recursive: true });
    expect(isGitRepositoryPath(nested)).toBe(false);
  });
});
