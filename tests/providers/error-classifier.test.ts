// tests/providers/error-classifier.test.ts
// M2 dev (happy-path unit): 错误分类器。每类至少 2 个真实 CLI 措辞变体（补充 §A9）。

import { describe, it, expect } from 'vitest';
import {
  isMissingSessionError,
  isPromptLimitError,
  isTransientCliError,
  isTimeoutError,
} from '@clowder/api/providers/error-classifier';

describe('error-classifier (unit, happy path)', () => {
  describe('isMissingSessionError', () => {
    it('matches Claude and Codex and Gemini missing-session variants', () => {
      expect(isMissingSessionError('No conversation found with session id abc123')).toBe(true);
      expect(isMissingSessionError('experimental-resume: unknown session')).toBe(true);
      expect(isMissingSessionError('resume failed: session expired')).toBe(true);
    });
    it('does not match unrelated errors or empty input', () => {
      expect(isMissingSessionError('prompt is too long')).toBe(false);
      expect(isMissingSessionError('')).toBe(false);
      expect(isMissingSessionError(undefined)).toBe(false);
    });
  });

  describe('isPromptLimitError', () => {
    it('matches Claude and Codex and Gemini prompt-limit variants', () => {
      expect(isPromptLimitError('prompt is too long')).toBe(true);
      expect(isPromptLimitError('This model maximum context length is 200000 tokens')).toBe(true);
      expect(isPromptLimitError('The input token count 1050000 exceeds the maximum limit')).toBe(true);
    });
    it('does not match a transient error', () => {
      expect(isPromptLimitError('service temporarily unavailable')).toBe(false);
      expect(isPromptLimitError(null)).toBe(false);
    });
  });

  describe('isTransientCliError', () => {
    it('matches overloaded / connection-reset / 503 variants', () => {
      expect(isTransientCliError('overloaded_error: please try again')).toBe(true);
      expect(isTransientCliError('stream disconnected: ECONNRESET')).toBe(true);
      expect(isTransientCliError('503 service unavailable')).toBe(true);
    });
    it('does not match a clean exit message', () => {
      expect(isTransientCliError('task completed successfully')).toBe(false);
      expect(isTransientCliError('')).toBe(false);
    });
  });

  describe('isTimeoutError', () => {
    it('matches timed-out / ETIMEDOUT / deadline-exceeded variants', () => {
      expect(isTimeoutError('request timed out')).toBe(true);
      expect(isTimeoutError('connect ETIMEDOUT 1.2.3.4:443')).toBe(true);
      expect(isTimeoutError('context deadline exceeded')).toBe(true);
    });
    it('does not match a missing-session error', () => {
      expect(isTimeoutError('No conversation found with session id x')).toBe(false);
      expect(isTimeoutError(undefined)).toBe(false);
    });
  });
});
