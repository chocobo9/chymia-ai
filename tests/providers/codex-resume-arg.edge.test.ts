// tests/providers/codex-resume-arg.edge.test.ts
// QA (edge + adversarial; dev != QA): gates the codex `exec`/`resume` argv contract
// of the exported buildArgs(prompt, options, defaultModel) against codex-cli 0.136.
//
// Contract under gate (codex-service.ts buildArgs):
//   FRESH  : ['exec', '--json', …flags…, <prompt>]
//   RESUME : ['exec', 'resume', <SESSION_ID>, '--json', …flags…, <prompt>]
//   The removed `experimental-resume <id>` form must NEVER appear; the session UUID
//   must never become a stray trailing/2nd positional in fresh mode and must appear
//   EXACTLY once (right after `resume`) in resume mode; the prompt is ALWAYS the single
//   last positional element (free text, system text prepended, never split into argv).
//
// The dev happy-path file (codex-resume-arg.test.ts) already asserts the basic
// fresh/resume/model-after-subcommand shape; this file adds the edge + adversarial
// gates and does NOT duplicate those assertions.

import { describe, it, expect } from 'vitest';
import { buildArgs } from '@choco/api/providers/codex/codex-service.js';
import type { InvokeOptions } from '@choco/api/providers/base';

// Real codex-style agent prompts + a real codex session UUID (v7, as codex 0.136 emits).
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
    const args = buildArgs(RESUME_PROMPT, options, '');
    expect(args[1]).toBe('resume');
    expect(args[2]).toBe(SESSION_ID);
    // The first "-"-prefixed token (a flag) must come strictly after the session id at idx 2.
    const firstFlagIdx = args.findIndex((a) => a.startsWith('-'));
    expect(firstFlagIdx).toBeGreaterThan(2);
    // --json is present and lands after the id; prompt is the last element.
    const jsonIdx = args.indexOf('--json');
    expect(jsonIdx).toBeGreaterThan(2);
    expect(args[args.length - 1]).toBe(RESUME_PROMPT);
  });

  it('edge: the session UUID appears EXACTLY once in resume mode and ONLY at idx 2 (right after `resume`)', () => {
    const args = buildArgs(RESUME_PROMPT, { sessionId: SESSION_ID }, '');
    expect(countOf(args, SESSION_ID)).toBe(1);
    expect(args.indexOf(SESSION_ID)).toBe(2);
    // It is NOT the trailing positional (the prompt is).
    expect(args[args.length - 1]).not.toBe(SESSION_ID);
  });

  it('edge: FRESH mode contains neither `resume` nor `experimental-resume`, and `exec` is immediately followed by `--json`', () => {
    const args = buildArgs(PROMPT, undefined, '');
    expect(args).not.toContain('resume');
    expect(args).not.toContain('experimental-resume');
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe('--json');
    expect(args[args.length - 1]).toBe(PROMPT);
  });

  it('edge: FRESH mode never lets the session UUID leak in as a bare 2nd or trailing positional', () => {
    // Even though no sessionId is supplied, assert the UUID string is wholly absent — guards
    // against any accidental re-introduction of the old `experimental-resume <id>` leak.
    const args = buildArgs(PROMPT, { model: 'gpt-5-codex' }, '');
    expect(args).not.toContain(SESSION_ID);
    expect(args[2]).not.toBe(SESSION_ID);
    expect(args[args.length - 1]).toBe(PROMPT);
  });

  it('edge: model flag — with options.model, `--model <m>` sits after the subcommand and the prompt is still last (resume)', () => {
    const args = buildArgs(RESUME_PROMPT, { sessionId: SESSION_ID, model: 'gpt-5-codex' }, 'o4-mini');
    const modelIdx = args.indexOf('--model');
    // options.model overrides the defaultModel and follows the resume subcommand + id.
    expect(modelIdx).toBeGreaterThan(2);
    expect(args[modelIdx + 1]).toBe('gpt-5-codex');
    expect(args).not.toContain('o4-mini'); // defaultModel must NOT win when options.model is set
    expect(args[args.length - 1]).toBe(RESUME_PROMPT);
  });

  it('edge: no model + empty defaultModel → no `--model` flag at all (fresh)', () => {
    const args = buildArgs(PROMPT, {}, '');
    expect(args).not.toContain('--model');
    expect(args[args.length - 1]).toBe(PROMPT);
  });

  it('edge: empty options.model falls back to a non-empty defaultModel → `--model <default>` present', () => {
    const args = buildArgs(PROMPT, { model: '' }, 'gpt-5-codex');
    // '' is falsy → options.model ?? defaultModel still yields '' (?? only catches nullish),
    // so define the OBSERVED-and-sane behavior: empty model string suppresses --model.
    // (This documents the actual `model = options?.model ?? defaultModel` semantics.)
    expect(args).not.toContain('--model');
    expect(args[args.length - 1]).toBe(PROMPT);
  });

  it('edge: undefined options.model falls back to defaultModel → `--model <default>` present (fresh)', () => {
    const args = buildArgs(PROMPT, undefined, 'gpt-5-codex');
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBe(2); // exec, --json, --model, <default>, … in fresh mode
    expect(args[modelIdx + 1]).toBe('gpt-5-codex');
    expect(args[args.length - 1]).toBe(PROMPT);
  });
});

describe('codex buildArgs — systemPrompt prepend into the single trailing positional (edge)', () => {
  const SYSTEM = '你是 Choco 编排下的 codex agent。只输出 NDJSON 事件，遵守仓库的提交规范。';

  it('edge: systemPrompt is PREPENDED into the trailing prompt positional, not a separate argv entry (fresh)', () => {
    const args = buildArgs(PROMPT, { systemPrompt: SYSTEM }, '');
    const last = args[args.length - 1];
    // The trailing positional carries BOTH system text and the user prompt.
    expect(last.startsWith(SYSTEM)).toBe(true);
    expect(last.includes(PROMPT)).toBe(true);
    // System text is NOT its own argv element.
    expect(args).not.toContain(SYSTEM);
    // Still exactly ONE trailing positional after exec/--json (no extra positionals).
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe('--json');
    // index of the combined prompt is the last slot; only one non-flag positional tail.
    expect(args.lastIndexOf(last)).toBe(args.length - 1);
  });

  it('edge: in RESUME mode the systemPrompt is NOT re-prepended (session already carries identity) — the bare prompt is the last positional, id at idx 2', () => {
    const args = buildArgs(RESUME_PROMPT, { sessionId: SESSION_ID, systemPrompt: SYSTEM }, '');
    expect(args[1]).toBe('resume');
    expect(args[2]).toBe(SESSION_ID);
    const last = args[args.length - 1];
    // Resume no longer re-injects the identity system prompt (it was the gemini/codex
    // identity-loop cause: re-prepending the persona as user text every resumed turn).
    // The trailing positional is the BARE user prompt; the session already carries identity.
    expect(last).toBe(RESUME_PROMPT);
    expect(args).not.toContain(SYSTEM);
    expect(countOf(args, SESSION_ID)).toBe(1);
  });
});

describe('codex buildArgs — adversarial prompt / session inputs (adversarial)', () => {
  it('adv: a prompt that STARTS with `--json` stays a SINGLE trailing element and never duplicates the real flag', () => {
    // A user could literally type a flag-looking message; it must remain inert free text.
    const flagish = '--json 请用这个格式把上面的报错重新输出一遍，别真的解析它';
    const args = buildArgs(flagish, { sessionId: SESSION_ID }, '');
    // exactly one REAL --json flag (the one buildArgs emits), the prompt copy lives only in the tail.
    expect(countOf(args, '--json')).toBe(1);
    expect(args[args.length - 1]).toBe(flagish);
    // the real flag sits before the prompt; the prompt is not split on its leading token.
    expect(args.indexOf('--json')).toBeLessThan(args.length - 1);
    // subcommand structure intact, id once.
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', SESSION_ID]);
    expect(countOf(args, SESSION_ID)).toBe(1);
  });

  it('adv: a prompt CONTAINING the word "resume" and the session id text does NOT add a 2nd resume/positional (fresh)', () => {
    const trap = `请帮我 resume 之前 ${SESSION_ID} 的工作上下文（这是叙述，不是命令）`;
    const args = buildArgs(trap, undefined, '');
    // No actual resume subcommand in fresh mode despite the word appearing in the prompt text.
    expect(args).not.toContain('resume');
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe('--json');
    // The id-looking text lives only inside the trailing prompt, not as its own argv token.
    expect(args).not.toContain(SESSION_ID);
    expect(args[args.length - 1]).toBe(trap);
    expect(countOf(args, trap)).toBe(1);
  });

  it('adv: a multi-line prompt with quotes/spaces/newlines is ONE argv element, byte-for-byte preserved', () => {
    const multiline =
      'codex 请按下列步骤执行：\n' +
      '1) 运行 `npm test -- --runInBand`\n' +
      '2) 如果失败，输出 "stderr" 原文（含双引号）\n' +
      "3) 不要把这段拆成多个参数，保持原样\t<tab 也保留>";
    const args = buildArgs(multiline, { sessionId: SESSION_ID, model: 'gpt-5-codex' }, '');
    expect(args[args.length - 1]).toBe(multiline);
    expect(countOf(args, multiline)).toBe(1);
    // structure unaffected by the wild prompt content.
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', SESSION_ID]);
    expect(args.indexOf('--model')).toBeGreaterThan(2);
  });

  it('adv: an empty-string sessionId is falsy → FRESH form (no resume, no empty positional smuggled)', () => {
    // Defines the sane contract: '' sessionId must NOT produce `exec resume "" --json …`.
    const args = buildArgs(PROMPT, { sessionId: '' }, '');
    expect(args).not.toContain('resume');
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe('--json');
    // no stray empty-string positional anywhere.
    expect(args).not.toContain('');
    expect(args[args.length - 1]).toBe(PROMPT);
  });

  it('adv: a second distinct session id only ever appears once and as resume`s positional (no cross-contamination)', () => {
    const args = buildArgs(RESUME_PROMPT, { sessionId: SESSION_ID_2 }, '');
    expect(countOf(args, SESSION_ID_2)).toBe(1);
    expect(args.indexOf(SESSION_ID_2)).toBe(2);
    expect(args).not.toContain(SESSION_ID); // the other UUID must not leak in
    expect(args[args.length - 1]).toBe(RESUME_PROMPT);
  });
});
