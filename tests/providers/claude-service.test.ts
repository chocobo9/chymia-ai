// tests/providers/claude-service.test.ts
// M2 dev (happy-path unit): ClaudeAgentService.buildArgs — permission-mode injection.
//
// Background: permissionMode is now an injectable ClaudeServiceDeps option, fed into
// the CLI args via `--permission-mode`. Default is 'bypassPermissions' (non-interactive
// auto-approve); controlled/sandbox callers can inject 'default' / 'plan'. There was NO
// unit test locking this; these assert buildArgs emits the flag with the correct value.

import { describe, it, expect } from 'vitest';
import {
  buildArgs,
  CLAUDE_PERMISSION_MODE_FLAG,
  CLAUDE_DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  ClaudeAgentService,
} from '@clowder/api/providers/claude/claude-service';
import type { InvokeOptions } from '@clowder/api/providers/base';
import { createAgentId } from '@clowder/shared';

const DEFAULT_MODEL = 'claude-opus-4-6';
const PROMPT = '@claude write a TODO API with CRUD endpoints';

/** Read the value immediately following a flag in an arg array. */
function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

describe('claude-service buildArgs — permission mode (unit, happy path)', () => {
  it('injects the default bypassPermissions mode when none is overridden', () => {
    // Arrange — service applies CLAUDE_DEFAULT_PERMISSION_MODE before calling buildArgs.
    const options: InvokeOptions | undefined = undefined;

    // Act
    const args = buildArgs(PROMPT, options, DEFAULT_MODEL, CLAUDE_DEFAULT_PERMISSION_MODE);

    // Assert — the flag is present exactly once and carries the default value.
    expect(args).toContain(CLAUDE_PERMISSION_MODE_FLAG);
    expect(args.filter((a) => a === CLAUDE_PERMISSION_MODE_FLAG)).toHaveLength(1);
    expect(valueAfter(args, CLAUDE_PERMISSION_MODE_FLAG)).toBe(CLAUDE_DEFAULT_PERMISSION_MODE);
    expect(CLAUDE_DEFAULT_PERMISSION_MODE).toBe('bypassPermissions');
  });

  it('injects an overridden "default" permission mode (no auto-approve sandbox)', () => {
    // Arrange — controlled caller injects the safe 'default' mode.
    const injected = 'default';

    // Act
    const args = buildArgs(PROMPT, undefined, DEFAULT_MODEL, injected);

    // Assert
    expect(valueAfter(args, CLAUDE_PERMISSION_MODE_FLAG)).toBe('default');
  });

  it('injects an overridden "plan" permission mode', () => {
    // Arrange
    const injected = 'plan';

    // Act
    const args = buildArgs(PROMPT, undefined, DEFAULT_MODEL, injected);

    // Assert
    expect(valueAfter(args, CLAUDE_PERMISSION_MODE_FLAG)).toBe('plan');
  });

  it('places the permission-mode flag among the args and keeps the prompt as the final positional', () => {
    // Arrange — a realistic resume + model + system-prompt invocation.
    const options: InvokeOptions = {
      sessionId: 'sess_018ab3f2-claude',
      model: 'claude-opus-4-6',
      systemPrompt: '你是 Clowder 团队的架构师，回答用中文。',
    };

    // Act
    const args = buildArgs(PROMPT, options, DEFAULT_MODEL, CLAUDE_DEFAULT_PERMISSION_MODE);

    // Assert — permission mode injected AND prompt is the last positional argument.
    expect(valueAfter(args, CLAUDE_PERMISSION_MODE_FLAG)).toBe('bypassPermissions');
    expect(args[args.length - 1]).toBe(PROMPT);
    // resume + model flags also threaded through.
    expect(valueAfter(args, '--resume')).toBe('sess_018ab3f2-claude');
    expect(valueAfter(args, '--model')).toBe('claude-opus-4-6');
  });
});

describe('claude-service permission-mode validation (unit, happy path)', () => {
  // Each valid mode (the verified CLI allow-list) is accepted and emitted verbatim, once.
  it.each(PERMISSION_MODES)('accepts the valid mode %s and emits it once', (mode) => {
    // Act
    const args = buildArgs(PROMPT, undefined, DEFAULT_MODEL, mode);

    // Assert
    expect(args.filter((a) => a === CLAUDE_PERMISSION_MODE_FLAG)).toHaveLength(1);
    expect(valueAfter(args, CLAUDE_PERMISSION_MODE_FLAG)).toBe(mode);
  });

  it('pins the verified CLI allow-list (claude --help: 6 choices)', () => {
    // The set is the config: lock it so an accidental edit is caught.
    expect([...PERMISSION_MODES]).toEqual([
      'acceptEdits',
      'auto',
      'bypassPermissions',
      'default',
      'dontAsk',
      'plan',
    ]);
  });

  it('buildArgs throws on a representative invalid mode (typo), naming the value', () => {
    // Arrange — a plausible typo of 'plan'.
    const typo = 'plna';

    // Act + Assert — fail-fast: the bad value never reaches the CLI.
    expect(() => buildArgs(PROMPT, undefined, DEFAULT_MODEL, typo)).toThrow(/plna/);
  });

  it('ClaudeAgentService constructor throws when configured with an invalid mode', () => {
    // Arrange
    const deps = {
      agentId: createAgentId('claude-opus'),
      // config/env-sourced string that slipped past compile-time typing.
      permissionMode: 'plna' as never,
    };

    // Act + Assert — misconfig fails early at construction.
    expect(() => new ClaudeAgentService(deps)).toThrow(/plna/);
  });

  it('ClaudeAgentService constructor succeeds with the default (unset) mode', () => {
    // Act + Assert — default path stays valid (bypassPermissions).
    expect(() => new ClaudeAgentService({ agentId: createAgentId('claude-opus') })).not.toThrow();
    expect(CLAUDE_DEFAULT_PERMISSION_MODE).toBe('bypassPermissions');
  });
});
