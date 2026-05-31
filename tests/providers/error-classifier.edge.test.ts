// tests/providers/error-classifier.edge.test.ts
// M2 QA (edge + adversarial): error-classifier. QA != dev.
// Gates the four classifiers against design §A9 (broad regex, "针对每个 CLI 收紧").
// >=2 REAL stderr variants per classifier from different CLIs, case/whitespace
// normalization, negatives (normal output must NOT be misclassified), the §A9
// timeout/transient overlap, and null/empty safety.

import { describe, it, expect } from 'vitest';
import {
  isMissingSessionError,
  isPromptLimitError,
  isTransientCliError,
  isTimeoutError,
} from '@clowder/api/providers/error-classifier';

describe('isMissingSessionError (edge)', () => {
  it('matches the real Claude Code resume failure', () => {
    expect(isMissingSessionError('Error: No conversation found with session id 4f1c-9a2b')).toBe(true);
  });

  it('matches a Codex experimental-resume unknown-session stderr', () => {
    expect(isMissingSessionError('experimental-resume failed: unknown session in rollout store')).toBe(true);
  });

  it('matches a Gemini expired-session resume failure', () => {
    expect(isMissingSessionError('resume failed: session expired, please start a new chat')).toBe(true);
  });

  it('matches an invalid-session phrasing', () => {
    expect(isMissingSessionError('invalid session id: refusing to resume')).toBe(true);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(isMissingSessionError('NO   CONVERSATION\nFOUND with session ID x')).toBe(true);
  });

  it('does NOT misclassify a normal reply that merely mentions the word session', () => {
    expect(isMissingSessionError('I started a fresh debugging session and reproduced the null deref.')).toBe(false);
  });

  it('does NOT misclassify a success line', () => {
    expect(isMissingSessionError('result: success, 3 files changed')).toBe(false);
  });
});

describe('isPromptLimitError (edge)', () => {
  it('matches the Anthropic prompt-too-long error', () => {
    expect(isPromptLimitError('prompt is too long: 215000 tokens > 200000 maximum')).toBe(true);
  });

  it('matches a Codex/OpenAI maximum-context-length error', () => {
    expect(isPromptLimitError('This model maximum context length is 128000 tokens, however you requested 131072')).toBe(true);
  });

  it('matches a Gemini input-token-count overflow', () => {
    expect(isPromptLimitError('The input token count 1050000 exceeds the maximum number of tokens allowed')).toBe(true);
  });

  it('matches a max_tokens phrasing', () => {
    expect(isPromptLimitError('request rejected: max_tokens exceeded for this model')).toBe(true);
  });

  it('does NOT misclassify text that merely discusses an auth token', () => {
    expect(isPromptLimitError('The auth token is stored in the GEMINI_API_KEY environment variable.')).toBe(false);
  });

  it('does NOT misclassify a transient error', () => {
    expect(isPromptLimitError('service temporarily unavailable, please retry')).toBe(false);
  });
});

describe('isTransientCliError (edge)', () => {
  it('matches a socket reset', () => {
    expect(isTransientCliError('stream disconnected: read ECONNRESET')).toBe(true);
  });

  it('matches a provider overload (529-style) message', () => {
    expect(isTransientCliError('overloaded_error: the model is currently overloaded, please try again')).toBe(true);
  });

  it('matches a gateway 503 from the CLI HTTP layer', () => {
    expect(isTransientCliError('upstream returned 503 service unavailable')).toBe(true);
  });

  it('matches a rate-limit message', () => {
    expect(isTransientCliError('429 too many requests; rate limit exceeded, retry after 12s')).toBe(true);
  });

  it('does NOT misclassify a plain success message', () => {
    expect(isTransientCliError('Task complete. All tests passed.')).toBe(false);
  });
});

describe('isTimeoutError (edge)', () => {
  it('matches our own watchdog message shape', () => {
    expect(isTimeoutError('claude cli timed out')).toBe(true);
  });

  it('matches a gRPC-style deadline exceeded', () => {
    expect(isTimeoutError('rpc error: code = DeadlineExceeded desc = context deadline exceeded')).toBe(true);
  });

  it('matches a single-word "timeout"', () => {
    expect(isTimeoutError('connection timeout while streaming response')).toBe(true);
  });

  it('matches ETIMEDOUT', () => {
    expect(isTimeoutError('connect ETIMEDOUT 10.0.0.5:443')).toBe(true);
  });

  it('does NOT misclassify a message lacking any timeout marker', () => {
    expect(isTimeoutError('Successfully applied patch to router.ts')).toBe(false);
  });
});

describe('classifier interaction — §A9 overlap & safety (adversarial)', () => {
  it('ETIMEDOUT is matched by BOTH transient and timeout so the caller applies priority', () => {
    const text = 'connect ETIMEDOUT 10.0.0.5:443';
    expect(isTransientCliError(text)).toBe(true);
    expect(isTimeoutError(text)).toBe(true);
  });

  it('a benign Chinese log line is classified by NONE of the four', () => {
    const benign = '已读取 packages/api/src/routing/router.ts，准备生成修复补丁。';
    expect(isMissingSessionError(benign)).toBe(false);
    expect(isPromptLimitError(benign)).toBe(false);
    expect(isTransientCliError(benign)).toBe(false);
    expect(isTimeoutError(benign)).toBe(false);
  });

  it('null / undefined / empty string are classified by NONE of the four (no throw)', () => {
    for (const input of [null, undefined, '']) {
      expect(isMissingSessionError(input)).toBe(false);
      expect(isPromptLimitError(input)).toBe(false);
      expect(isTransientCliError(input)).toBe(false);
      expect(isTimeoutError(input)).toBe(false);
    }
  });
});
