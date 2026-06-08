// tests/providers/codex-resume-arg.test.ts
// DEV happy-path: codex `exec` argv — fresh run vs session resume (codex-cli 0.136).
//
// Bug fixed: we used the removed `experimental-resume <id>` form, so codex 0.136
// treated the session UUID as a stray positional → "unexpected argument '<uuid>'".
// The fix emits `codex exec resume <SESSION_ID> --json …` (resume is a subcommand
// of exec; the session id is its first positional). The prompt now goes via STDIN
// (argv ends with `-- -`, aligned to Clowder), so it is asserted through
// buildStdinPrompt — never the trailing argv. QA owns the edge/adversarial cases.

import { describe, it, expect } from 'vitest';
import { buildArgs, buildStdinPrompt } from '@choco/api/providers/codex/codex-service.js';
import type { InvokeOptions } from '@choco/api/providers/base';

const PROMPT = '@codex 给登录路由加上基于令牌桶的限流，并补一个单测';
const SESSION_ID = '019e86ef-ee2f-7360-bcdb-787dff07115f';

describe('codex buildArgs — exec / resume subcommand (codex-cli 0.136)', () => {
  it('a fresh run is `codex exec --json … -- -` (no resume; prompt via stdin)', () => {
    const args = buildArgs(undefined, '');
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe('--json'); // --json comes right after exec on a fresh run
    expect(args).not.toContain('resume');
    expect(args).not.toContain('experimental-resume');
    expect(args.slice(-2)).toEqual(['--', '-']); // prompt read from stdin, not argv
    expect(buildStdinPrompt(PROMPT, undefined)).toBe(PROMPT);
  });

  it('a resume run is `codex exec resume <SESSION_ID> --json … -- -`', () => {
    const options: InvokeOptions = { sessionId: SESSION_ID };
    const args = buildArgs(options, '');
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe('resume'); // resume subcommand right after exec
    expect(args[2]).toBe(SESSION_ID); // session id is resume's first positional
    expect(args[3]).toBe('--json'); // flags follow the subcommand + id
    expect(args).not.toContain('experimental-resume'); // the removed old form is gone
    expect(args.slice(-2)).toEqual(['--', '-']);
  });

  it('resume passes the model flag after the subcommand; argv still ends with -- -', () => {
    const args = buildArgs({ sessionId: SESSION_ID, model: 'gpt-5-codex' }, '');
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', SESSION_ID]);
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThan(3);
    expect(args[modelIdx + 1]).toBe('gpt-5-codex');
    expect(args.slice(-2)).toEqual(['--', '-']);
  });
});
