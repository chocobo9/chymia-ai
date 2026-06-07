// @vitest-environment jsdom
// Bug: scope selector (lockByThread) resets to 全体 after page refresh.
// Fix: persist lockByThread to localStorage so thread scope survives reload.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  readScopeLock,
  writeScopeLock,
  clearScopeLock,
} from '@choco/web/lib/scope-persist';

beforeEach(() => {
  localStorage.clear();
});

describe('scope-persist: lockByThread localStorage round-trip', () => {
  it('returns empty record when nothing saved', () => {
    expect(readScopeLock()).toEqual({});
  });

  it('round-trips a single thread lock', () => {
    writeScopeLock({ 'thread-a': 'claude-opus' });
    expect(readScopeLock()).toEqual({ 'thread-a': 'claude-opus' });
  });

  it('round-trips multiple thread locks', () => {
    const locks = {
      'thread-a': 'claude-opus',
      'thread-b': 'gemini-pro',
    };
    writeScopeLock(locks);
    expect(readScopeLock()).toEqual(locks);
  });

  it('overwrites previous value', () => {
    writeScopeLock({ 'thread-a': 'claude-opus' });
    writeScopeLock({ 'thread-a': 'codex-gpt' });
    expect(readScopeLock()).toEqual({ 'thread-a': 'codex-gpt' });
  });

  it('clearScopeLock removes the stored value', () => {
    writeScopeLock({ 'thread-a': 'claude-opus' });
    clearScopeLock();
    expect(readScopeLock()).toEqual({});
  });

  it('handles corrupted localStorage gracefully', () => {
    localStorage.setItem('choco:lockByThread', 'not-valid-json!!!');
    expect(readScopeLock()).toEqual({});
  });

  it('handles non-object localStorage gracefully', () => {
    localStorage.setItem('choco:lockByThread', '"just a string"');
    expect(readScopeLock()).toEqual({});
  });
});
