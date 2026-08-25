// tests/providers/claude-mcp-arg-order.test.ts
// QA regression (edge/adversarial): claude `--mcp-config <configs...>` is VARIADIC.
//
// Original bug: `--mcp-config <value>` was the LAST flag before the positional prompt,
// so claude greedily ate the prompt as a 2nd config path. The fix moved `--mcp-config`
// to right after CLAUDE_BASE_ARGS (before the unconditional `--permission-mode`), so a
// `-`-prefixed flag terminates the variadic.
//
// SINCE: the prompt now goes via STDIN (no argv positional — Windows ENAMETOOLONG /
// argv-exposure fix), so the variadic can no longer reach a prompt at all. These tests
// keep gating the `--mcp-config` ↔ value ↔ terminating-flag ordering, and assert the
// prompt is NEVER an argv element (it is piped to stdin, verified via buildStdinPrompt).
//
// dev≠QA: this file calls the REAL exported buildArgs(...) / buildStdinPrompt(...).

import { describe, it, expect } from 'vitest';
import {
  buildArgs,
  buildStdinPrompt,
  CLAUDE_PERMISSION_MODE_FLAG,
  CLAUDE_DEFAULT_PERMISSION_MODE,
  MCP_CONFIG_ENV_KEY,
} from '@choco/api/providers/claude/claude-service';
import type { InvokeOptions } from '@choco/api/providers/base';

const CLAUDE_MCP_CONFIG_FLAG = '--mcp-config';
const DEFAULT_MODEL = 'claude-opus-4-6';
const PROMPT = '@claude review the auth middleware and add rate limiting to the login route';

const MCP_CONFIG_PATH = 'C:\\Users\\x\\Temp\\choco-mcp-abc\\mcp-config.json';
const MCP_CONFIG_INLINE =
  '{"mcpServers":{"choco":{"command":"node","args":["server.js"],"env":{"TOKEN":"abc123"}}}}';

/** Index of the value that immediately follows the given flag (or -1 if flag absent). */
function valueIndexAfter(args: readonly string[], flag: string): number {
  const idx = args.indexOf(flag);
  return idx >= 0 ? idx + 1 : -1;
}

function withMcp(value: string): InvokeOptions {
  return { callbackEnv: { [MCP_CONFIG_ENV_KEY]: value } };
}

describe('claude buildArgs — --mcp-config variadic + prompt-via-stdin (QA regression)', () => {
  // ── #1 CORE GATE: the token after the --mcp-config value is a flag (terminates the variadic). ──
  it.each([
    ['win32 path-like value', MCP_CONFIG_PATH],
    ['inline-JSON-string value', MCP_CONFIG_INLINE],
  ])(
    'core gate (%s): the token right after the --mcp-config value starts with "-" (a flag terminates the variadic)',
    (_label, mcpValue) => {
      const args = buildArgs(withMcp(mcpValue), DEFAULT_MODEL, CLAUDE_DEFAULT_PERMISSION_MODE);
      const valueIdx = valueIndexAfter(args, CLAUDE_MCP_CONFIG_FLAG);
      expect(valueIdx).toBeGreaterThan(0);
      const tokenAfterValue = args[valueIdx + 1];
      expect(tokenAfterValue).toBeDefined();
      expect(tokenAfterValue?.startsWith('-')).toBe(true);
      expect(tokenAfterValue).toBe(CLAUDE_PERMISSION_MODE_FLAG);
    },
  );

  // ── #2 PROMPT VIA STDIN: the prompt is NEVER an argv element. ──
  it.each([
    ['win32 path-like value', MCP_CONFIG_PATH],
    ['inline-JSON-string value', MCP_CONFIG_INLINE],
  ])(
    'prompt safety (%s): the prompt is NEVER an argv element (it is piped to stdin)',
    (_label, mcpValue) => {
      const options: InvokeOptions = {
        ...withMcp(mcpValue),
        sessionId: 'sess_018ab3f2-claude',
        model: 'claude-opus-4-6',
        systemPrompt: '你是 Choco 团队的架构师，回答用中文。',
      };
      // systemPrompt → a file flag (caller writes the temp file); pass a stand-in path.
      const args = buildArgs(options, DEFAULT_MODEL, CLAUDE_DEFAULT_PERMISSION_MODE, '/tmp/system-prompt.md');
      expect(args).not.toContain(PROMPT); // prompt is on stdin, not argv
      // claude injectsL0Natively → system prompt does NOT go into the stdin text.
      expect(buildStdinPrompt(PROMPT, options)).toBe(PROMPT);
      expect(args).not.toContain(options.systemPrompt); // system text is via the file flag, not argv
      expect(args).toContain('--append-system-prompt-file');
    },
  );

  // ── #3 ADJACENCY: --mcp-config is still immediately followed by its exact verbatim value. ──
  it.each([
    ['win32 path-like value', MCP_CONFIG_PATH],
    ['inline-JSON-string value', MCP_CONFIG_INLINE],
  ])(
    'adjacency (%s): --mcp-config is immediately followed by its exact value (flag↔value pairing intact)',
    (_label, mcpValue) => {
      const args = buildArgs(withMcp(mcpValue), DEFAULT_MODEL, CLAUDE_DEFAULT_PERMISSION_MODE);
      expect(args.filter((a) => a === CLAUDE_MCP_CONFIG_FLAG)).toHaveLength(1);
      const flagIdx = args.indexOf(CLAUDE_MCP_CONFIG_FLAG);
      expect(args[flagIdx + 1]).toBe(mcpValue);
    },
  );

  // ── #4 NO-MCP CASE: absent MCP_CONFIG_JSON → no --mcp-config; prompt still via stdin. ──
  it('no-mcp case: absent MCP_CONFIG_JSON → no --mcp-config flag; the prompt is not in argv', () => {
    const args = buildArgs({ model: 'claude-opus-4-6' }, DEFAULT_MODEL, CLAUDE_DEFAULT_PERMISSION_MODE);
    expect(args).not.toContain(CLAUDE_MCP_CONFIG_FLAG);
    expect(args).not.toContain(PROMPT);
  });

  it('no-mcp case: empty-string MCP_CONFIG_JSON is falsy → no --mcp-config flag', () => {
    const args = buildArgs(withMcp(''), DEFAULT_MODEL, CLAUDE_DEFAULT_PERMISSION_MODE);
    expect(args).not.toContain(CLAUDE_MCP_CONFIG_FLAG);
  });

  // ── #5 ADVERSARIAL: a flag/path-looking prompt goes to stdin, NEVER argv (no variadic/injection surface). ──
  it.each([
    ['flag-looking prompt', '--mcp-config C:\\evil\\inject.json && rm -rf'],
    ['absolute-path-looking prompt', '/etc/passwd please summarize this file for me'],
    ['double-dash leading prompt', '--help is what the user literally typed as their request'],
  ])(
    'adversarial (%s): the tricky prompt is piped to stdin, never an argv element',
    (_label, trickyPrompt) => {
      const options = withMcp(MCP_CONFIG_PATH);
      const args = buildArgs(options, DEFAULT_MODEL, CLAUDE_DEFAULT_PERMISSION_MODE);
      // The tricky text never enters argv → there is no variadic/flag-injection surface.
      expect(args).not.toContain(trickyPrompt);
      expect(buildStdinPrompt(trickyPrompt, options)).toBe(trickyPrompt);
      const valueIdx = valueIndexAfter(args, CLAUDE_MCP_CONFIG_FLAG);
      expect(args[valueIdx]).toBe(MCP_CONFIG_PATH);
      expect(args[valueIdx + 1]?.startsWith('-')).toBe(true);
    },
  );
});
