// M14 message-splitter dev happy-path suite. QA owns edge + adversarial coverage.
//
// Verifies the 4096-char split keeps each chunk within the limit, reassembles to
// the original, and never lands a boundary inside a surrogate pair, an HTML tag,
// or an HTML entity. Realistic long agent content — no placeholders.

import { describe, it, expect } from 'vitest';
import {
  splitHtmlMessage,
  TELEGRAM_MAX_MESSAGE_LENGTH,
} from '@choco/adapters/telegram/message-splitter';

describe('splitHtmlMessage (happy path)', () => {
  it('returns the input unchanged in a single chunk when within the limit', () => {
    const html = '<b>评估结论</b>: 读多写少建议 SQLite，写密集建议 Postgres。';
    expect(splitHtmlMessage(html)).toEqual([html]);
  });

  it('returns a single empty-string chunk for empty input', () => {
    expect(splitHtmlMessage('')).toEqual(['']);
  });

  it('splits a 5000-char message into chunks each within the limit', () => {
    const html = '数据库选型评估报告。'.repeat(500); // 10 chars * 500 = 5000 code units
    const parts = splitHtmlMessage(html);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    }
    expect(parts.join('')).toBe(html);
  });

  it('does not split a surrogate pair at the boundary', () => {
    // '🐱' is a surrogate pair (2 UTF-16 code units). Place one exactly at the limit.
    const head = 'a'.repeat(TELEGRAM_MAX_MESSAGE_LENGTH - 1);
    const html = `${head}🐱tail`;
    const parts = splitHtmlMessage(html);

    // The first chunk must not end on a lone high surrogate.
    const first = parts[0] ?? '';
    const lastCode = first.charCodeAt(first.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
    // Round-trips and the cat emoji stays intact in the second chunk.
    expect(parts.join('')).toBe(html);
    expect(parts.join('')).toContain('🐱');
  });

  it('does not split inside an HTML tag at the boundary', () => {
    // Drive a <b> opening tag to straddle the 4096 boundary.
    const head = 'x'.repeat(TELEGRAM_MAX_MESSAGE_LENGTH - 2);
    const html = `${head}<b>重点结论在这里</b>`;
    const parts = splitHtmlMessage(html);

    // No chunk may contain an unterminated '<' without its matching '>'.
    for (const part of parts) {
      const lastOpen = part.lastIndexOf('<');
      if (lastOpen !== -1) {
        expect(part.indexOf('>', lastOpen)).toBeGreaterThan(lastOpen);
      }
    }
    expect(parts.join('')).toBe(html);
  });

  it('does not split inside an HTML entity at the boundary', () => {
    // Drive an &amp; entity to straddle the 4096 boundary.
    const head = 'y'.repeat(TELEGRAM_MAX_MESSAGE_LENGTH - 2);
    const html = `${head}&amp; 继续后续内容`;
    const parts = splitHtmlMessage(html);

    for (const part of parts) {
      const lastAmp = part.lastIndexOf('&');
      if (lastAmp !== -1) {
        // An '&' must be followed by its ';' within the same chunk, or be the
        // final entity fully contained.
        expect(part.indexOf(';', lastAmp)).toBeGreaterThan(lastAmp);
      }
    }
    expect(parts.join('')).toBe(html);
  });
});
