// tests/providers/claude-mcp-arg-order.test.ts
// QA regression (edge/adversarial): claude `--mcp-config <configs...>` is VARIADIC.
//
// Bug being gated: `--mcp-config <value>` used to be the LAST flag before the positional
// prompt, so claude's parser greedily ate the prompt as a 2nd config path (real error:
// "Invalid MCP configuration: MCP config file not found: …<the prompt>"). The fix moved the
// `--mcp-config` push to immediately after CLAUDE_BASE_ARGS (before the unconditional
// `--permission-mode`), so a `-`-prefixed flag now follows the value and terminates the
// variadic before the prompt.
//
// dev≠QA: this file is authored by QA (no product-code authorship). It calls the REAL
// exported buildArgs(...) and asserts the arg ordering that the variadic depends on.

import { describe, it, expect } from 'vitest';
import {
  buildArgs,
  CLAUDE_PERMISSION_MODE_FLAG,
  CLAUDE_DEFAULT_PERMISSION_MODE,
  MCP_CONFIG_ENV_KEY,
} from '@choco/api/providers/claude/claude-service';
import type { InvokeOptions } from '@choco/api/providers/base';

// `CLAUDE_MCP_CONFIG_FLAG` is module-private in claude-service.ts (not exported); we mirror
// the literal here. This is the exact flag claude exposes as `--mcp-config <configs...>`,
// verified against the dev's source and `claude --help`. Kept local to avoid touching
// product code (QA must not change the exported surface).
const CLAUDE_MCP_CONFIG_FLAG = '--mcp-config';

const DEFAULT_MODEL = 'claude-opus-4-6';
const PROMPT = '@claude review the auth middleware and add rate limiting to the login route';

// Realistic MCP config values that a producer (M8 app-factory) actually emits:
// win32 path-like (the common case — claude reads the file) AND an inline JSON string.
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

describe('claude buildArgs — --mcp-config variadic arg-order (QA regression)', () => {
  // ── #1 CORE GATE: the token after the --mcp-config value is a flag, not the prompt. ──
  // This is the assertion that FAILS on the pre-fix order (value followed by the prompt)
  // and PASSES on the fixed order (value followed by `--permission-mode`).
  it.each([
    ['win32 path-like value', MCP_CONFIG_PATH],
    ['inline-JSON-string value', MCP_CONFIG_INLINE],
  ])(
    'core gate (%s): the token right after the --mcp-config value starts with "-" (a flag terminates the variadic)',
    (_label, mcpValue) => {
      // Arrange
      const options = withMcp(mcpValue);

      // Act
      const args = buildArgs(PROMPT, options, DEFAULT_MODEL, CLAUDE_DEFAULT_PERMISSION_MODE);

      // Assert — flag present, and value+1 is a `-`-prefixed flag (NOT a positional/prompt).
      const valueIdx = valueIndexAfter(args, CLAUDE_MCP_CONFIG_FLAG);
      expect(valueIdx).toBeGreaterThan(0);
      const tokenAfterValue = args[valueIdx + 1];
      expect(tokenAfterValue).toBeDefined();
      expect(tokenAfterValue?.startsWith('-')).toBe(true);
      // Concretely, the fix terminates the variadic with --permission-mode.
      expect(tokenAfterValue).toBe(CLAUDE_PERMISSION_MODE_FLAG);
    },
  );

  // ── #2 PROMPT SAFETY: prompt is last, and is NOT sitting right after the mcp value. ──
  it.each([
    ['win32 path-like value', MCP_CONFIG_PATH],
    ['inline-JSON-string value', MCP_CONFIG_INLINE],
  ])(
    'prompt safety (%s): the prompt is the LAST arg and the element before it is not the mcp-config value',
    (_label, mcpValue) => {
      // Arrange — a realistic full invocation (resume + model + system prompt) so the prompt
      // is genuinely the last positional among several trailing flags.
      const options: InvokeOptions = {
        ...withMcp(mcpValue),
        sessionId: 'sess_018ab3f2-claude',
        model: 'claude-opus-4-6',
        systemPrompt: '你是 Choco 团队的架构师，回答用中文。',
      };

      // Act
      const args = buildArgs(PROMPT, options, DEFAULT_MODEL, CLAUDE_DEFAULT_PERMISSION_MODE);

      // Assert
      expect(args[args.length - 1]).toBe(PROMPT);
      const valueIdx = valueIndexAfter(args, CLAUDE_MCP_CONFIG_FLAG);
      // The element immediately before the prompt must not be the mcp-config value, i.e.
      // the prompt cannot be the token the variadic would consume.
      expect(args[args.length - 2]).not.toBe(mcpValue);
      expect(valueIdx).not.toBe(args.length - 2);
    },
  );

  // ── #3 ADJACENCY: --mcp-config is still immediately followed by its exact verbatim value. ──
  it.each([
    ['win32 path-like value', MCP_CONFIG_PATH],
    ['inline-JSON-string value', MCP_CONFIG_INLINE],
  ])(
    'adjacency (%s): --mcp-config is immediately followed by its exact value (flag↔value pairing intact)',
    (_label, mcpValue) => {
      // Arrange
      const options = withMcp(mcpValue);

      // Act
      const args = buildArgs(PROMPT, options, DEFAULT_MODEL, CLAUDE_DEFAULT_PERMISSION_MODE);

      // Assert — flag once, and the very next token is the unmodified value.
      expect(args.filter((a) => a === CLAUDE_MCP_CONFIG_FLAG)).toHaveLength(1);
      const flagIdx = args.indexOf(CLAUDE_MCP_CONFIG_FLAG);
      expect(args[flagIdx + 1]).toBe(mcpValue);
    },
  );

  // ── #4 NO-MCP CASE: absent MCP_CONFIG_JSON → no --mcp-config, prompt still last. ──
  it('no-mcp case: when MCP_CONFIG_JSON is absent, no --mcp-config flag appears and the prompt stays last', () => {
    // Arrange — common path, no callbackEnv MCP key.
    const options: InvokeOptions = { model: 'claude-opus-4-6' };

    // Act
    const args = buildArgs(PROMPT, options, DEFAULT_MODEL, CLAUDE_DEFAULT_PERMISSION_MODE);

    // Assert
    expect(args).not.toContain(CLAUDE_MCP_CONFIG_FLAG);
    expect(args[args.length - 1]).toBe(PROMPT);
  });

  it('no-mcp case: empty-string MCP_CONFIG_JSON is falsy → no --mcp-config flag, prompt last', () => {
    // Arrange — an empty value is falsy; the producer treats "no config" as absent.
    const options = withMcp('');

    // Act
    const args = buildArgs(PROMPT, options, DEFAULT_MODEL, CLAUDE_DEFAULT_PERMISSION_MODE);

    // Assert
    expect(args).not.toContain(CLAUDE_MCP_CONFIG_FLAG);
    expect(args[args.length - 1]).toBe(PROMPT);
  });

  // ── #5 ADVERSARIAL: a prompt that LOOKS like a flag / absolute path is still the last
  //    positional and is never confused with the mcp-config value. ──
  it.each([
    ['flag-looking prompt', '--mcp-config C:\\evil\\inject.json && rm -rf'],
    ['absolute-path-looking prompt', '/etc/passwd please summarize this file for me'],
    ['double-dash leading prompt', '--help is what the user literally typed as their request'],
  ])(
    'adversarial (%s): the tricky prompt is safely the LAST positional, distinct from the mcp-config value',
    (_label, trickyPrompt) => {
      // Arrange — MCP present so the variadic is active AND the prompt looks dangerous.
      const options = withMcp(MCP_CONFIG_PATH);

      // Act
      const args = buildArgs(trickyPrompt, options, DEFAULT_MODEL, CLAUDE_DEFAULT_PERMISSION_MODE);

      // Assert — prompt is last; the token after the mcp value is still a terminating flag;
      // the mcp value is exactly the config (never the prompt).
      expect(args[args.length - 1]).toBe(trickyPrompt);
      const valueIdx = valueIndexAfter(args, CLAUDE_MCP_CONFIG_FLAG);
      expect(args[valueIdx]).toBe(MCP_CONFIG_PATH);
      expect(args[valueIdx]).not.toBe(trickyPrompt);
      expect(args[valueIdx + 1]?.startsWith('-')).toBe(true);
    },
  );
});
