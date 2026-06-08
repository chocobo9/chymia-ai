// tests/providers/codex-resume-arg.edge.test.ts
// QA (edge + adversarial; dev != QA): codex `exec`/`resume` argv contract of the
// exported buildArgs(options, defaultModel) against codex-cli 0.136. The PROMPT now
// goes via STDIN (`-- -`, aligned to Clowder), so argv NEVER carries the prompt or
// system text — the trailing positional is ALWAYS the `-- -` stdin marker, and prompt
// content is asserted through buildStdinPrompt.
//
// Contract under gate (codex-service.ts buildArgs):
//   FRESH  : ['exec', '--json', …flags…, '--', '-']
//   RESUME : ['exec', 'resume', <SESSION_ID>, '--json', …flags…, '--', '-']
//   The removed `experimental-resume <id>` form must NEVER appear; the session UUID
//   appears EXACTLY once (idx 2) in resume mode and NEVER in fresh; the prompt/system
//   text is NEVER an argv element (it is piped to stdin).

import { describe, it, expect } from 'vitest';
import { buildArgs, buildStdinPrompt } from '@choco/api/providers/codex/codex-service.js';
import type { InvokeOptions } from '@choco/api/providers/base';

const SESSION_ID = '019e86ef-ee2f-7360-bcdb-787dff07115f';
const SESSION_ID_2 = '01926d4c-3b1a-7c00-9f2e-0a1b2c3d4e5f';
const PROMPT = '@codex 把 OrderService.finalize 的库存扣减改成乐观锁重试，并补一个并发回归测试';
const RESUME_PROMPT = '@codex 上一轮的乐观锁实现漏了 version 字段递增，请修一下并重跑测试';

/** Count how many times a value occurs in an argv array. */
function countOf(args: readonly string[], value: string): number {
  return args.filter((a) => a === value).length;
}

describe('codex buildArgs — resume positional ordering (edge)', () => {
  it('edge: resume places `resume` at idx 1 and the session id at idx 2, both BEFORE any "-"-flag', () => {
    const options: InvokeOptions = { sessionId: SESSION_ID, model: 'gpt-5-codex' };
    const args = buildArgs(options, '');
    expect(args[1]).toBe('resume');
    expect(args[2]).toBe(SESSION_ID);
    const firstFlagIdx = args.findIndex((a) => a.startsWith('-'));
    expect(firstFlagIdx).toBeGreaterThan(2);
    const jsonIdx = args.indexOf('--json');
    expect(jsonIdx).toBeGreaterThan(2);
    expect(args.slice(-2)).toEqual(['--', '-']); // prompt via stdin, not argv
  });

  it('edge: the session UUID appears EXACTLY once in resume mode and ONLY at idx 2', () => {
    const args = buildArgs({ sessionId: SESSION_ID }, '');
    expect(countOf(args, SESSION_ID)).toBe(1);
    expect(args.indexOf(SESSION_ID)).toBe(2);
    expect(args[args.length - 1]).not.toBe(SESSION_ID); // the trailing positional is `-`
  });

  it('edge: FRESH mode contains neither `resume` nor `experimental-resume`; `exec` then `--json`', () => {
    const args = buildArgs(undefined, '');
    expect(args).not.toContain('resume');
    expect(args).not.toContain('experimental-resume');
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe('--json');
    expect(args.slice(-2)).toEqual(['--', '-']);
  });

  it('edge: FRESH mode never lets the session UUID leak into argv', () => {
    const args = buildArgs({ model: 'gpt-5-codex' }, '');
    expect(args).not.toContain(SESSION_ID);
    expect(args[2]).not.toBe(SESSION_ID);
    expect(args.slice(-2)).toEqual(['--', '-']);
  });

  it('edge: options.model overrides defaultModel and follows the resume subcommand', () => {
    const args = buildArgs({ sessionId: SESSION_ID, model: 'gpt-5-codex' }, 'o4-mini');
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThan(2);
    expect(args[modelIdx + 1]).toBe('gpt-5-codex');
    expect(args).not.toContain('o4-mini'); // defaultModel must NOT win when options.model is set
    expect(args.slice(-2)).toEqual(['--', '-']);
  });

  it('edge: no model + empty defaultModel → no `--model` flag (fresh)', () => {
    const args = buildArgs({}, '');
    expect(args).not.toContain('--model');
    expect(args.slice(-2)).toEqual(['--', '-']);
  });

  it('edge: undefined options.model falls back to defaultModel → `--model <default>` (fresh)', () => {
    const args = buildArgs(undefined, 'gpt-5-codex');
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBe(2); // exec, --json, --model, <default>, …
    expect(args[modelIdx + 1]).toBe('gpt-5-codex');
    expect(args.slice(-2)).toEqual(['--', '-']);
  });
});

describe('codex buildStdinPrompt — systemPrompt prepend into stdin (edge)', () => {
  const SYSTEM = '你是 Choco 编排下的 codex agent。只输出 NDJSON 事件，遵守仓库的提交规范。';

  it('edge: systemPrompt is PREPENDED into the stdin text on a fresh turn, never into argv', () => {
    const stdin = buildStdinPrompt(PROMPT, { systemPrompt: SYSTEM });
    expect(stdin.startsWith(SYSTEM)).toBe(true);
    expect(stdin.includes(PROMPT)).toBe(true);
    // argv carries neither the system nor the prompt text.
    const args = buildArgs({ systemPrompt: SYSTEM }, '');
    expect(args).not.toContain(SYSTEM);
    expect(args.slice(-2)).toEqual(['--', '-']);
  });

  it('edge: in RESUME the systemPrompt is NOT re-prepended (session already carries identity)', () => {
    const stdin = buildStdinPrompt(RESUME_PROMPT, { sessionId: SESSION_ID, systemPrompt: SYSTEM });
    // Resume no longer re-injects identity (the gemini/codex identity-loop cause:
    // re-prepending the persona as user text every resumed turn). stdin is the BARE prompt.
    expect(stdin).toBe(RESUME_PROMPT);
    const args = buildArgs({ sessionId: SESSION_ID, systemPrompt: SYSTEM }, '');
    expect(args[1]).toBe('resume');
    expect(args[2]).toBe(SESSION_ID);
    expect(args).not.toContain(SYSTEM);
    expect(countOf(args, SESSION_ID)).toBe(1);
  });
});

describe('codex — adversarial prompt / session inputs (adversarial)', () => {
  it('adv: a prompt that STARTS with `--json` stays in stdin and never duplicates the real flag', () => {
    const flagish = '--json 请用这个格式把上面的报错重新输出一遍，别真的解析它';
    const args = buildArgs({ sessionId: SESSION_ID }, '');
    expect(countOf(args, '--json')).toBe(1); // only the real flag; the prompt is in stdin
    expect(buildStdinPrompt(flagish, { sessionId: SESSION_ID })).toBe(flagish);
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', SESSION_ID]);
    expect(countOf(args, SESSION_ID)).toBe(1);
    expect(args.slice(-2)).toEqual(['--', '-']);
  });

  it('adv: a prompt CONTAINING "resume" + session id text does NOT add a 2nd resume/positional (fresh)', () => {
    const trap = `请帮我 resume 之前 ${SESSION_ID} 的工作上下文（这是叙述，不是命令）`;
    const args = buildArgs(undefined, '');
    expect(args).not.toContain('resume');
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe('--json');
    expect(args).not.toContain(SESSION_ID); // id-looking text lives only inside stdin
    expect(buildStdinPrompt(trap, undefined)).toBe(trap);
    expect(args.slice(-2)).toEqual(['--', '-']);
  });

  it('adv: a multi-line prompt with quotes/spaces/newlines is byte-for-byte preserved in stdin', () => {
    const multiline =
      'codex 请按下列步骤执行：\n' +
      '1) 运行 `npm test -- --runInBand`\n' +
      '2) 如果失败，输出 "stderr" 原文（含双引号）\n' +
      "3) 不要把这段拆成多个参数，保持原样\t<tab 也保留>";
    expect(buildStdinPrompt(multiline, { sessionId: SESSION_ID })).toBe(multiline);
    const args = buildArgs({ sessionId: SESSION_ID, model: 'gpt-5-codex' }, '');
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', SESSION_ID]);
    expect(args.indexOf('--model')).toBeGreaterThan(2);
    expect(args.slice(-2)).toEqual(['--', '-']);
  });

  it('adv: an empty-string sessionId is falsy → FRESH form (no resume smuggled)', () => {
    const args = buildArgs({ sessionId: '' }, '');
    expect(args).not.toContain('resume');
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe('--json');
    expect(args.slice(-2)).toEqual(['--', '-']);
  });

  it('adv: a second distinct session id only ever appears once at idx 2', () => {
    const args = buildArgs({ sessionId: SESSION_ID_2 }, '');
    expect(countOf(args, SESSION_ID_2)).toBe(1);
    expect(args.indexOf(SESSION_ID_2)).toBe(2);
    expect(args).not.toContain(SESSION_ID); // the other UUID must not leak in
    expect(args.slice(-2)).toEqual(['--', '-']);
  });
});
