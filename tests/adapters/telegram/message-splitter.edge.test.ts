// M14 message-splitter QA edge + adversarial suite (authored by QA, not the dev).
//
// FOCUS: splitHtmlMessage must split a >4096 Telegram-HTML payload so that NO chunk
// (a) exceeds 4096 UTF-16 code units, (b) ends on a lone high surrogate, (c) cuts an
// `&...;` entity in half, or (d) cuts a `<...>` tag in half — because Telegram rejects
// oversized payloads and malformed HTML. The split must also always reconstruct the
// input exactly and always make forward progress (no infinite loop) even for a single
// unbreakable token longer than the limit.
//
// All boundary cases are driven to straddle the 4096 mark precisely. Realistic long
// agent HTML — no placeholders.

import { describe, it, expect } from 'vitest';
import {
  splitHtmlMessage,
  TELEGRAM_MAX_MESSAGE_LENGTH as LIMIT,
} from '@choco/adapters/telegram/message-splitter';

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;

/** Every chunk is within the Telegram limit. */
function expectAllWithinLimit(parts: readonly string[]): void {
  for (const part of parts) {
    expect(part.length).toBeLessThanOrEqual(LIMIT);
  }
}

/** No chunk ends on a lone high surrogate and none starts on a lone low surrogate. */
function expectNoLoneSurrogates(parts: readonly string[]): void {
  for (const part of parts) {
    if (part.length === 0) continue;
    const last = part.charCodeAt(part.length - 1);
    expect(last >= HIGH_SURROGATE_MIN && last <= HIGH_SURROGATE_MAX).toBe(false);
    const first = part.charCodeAt(0);
    expect(first >= LOW_SURROGATE_MIN && first <= LOW_SURROGATE_MAX).toBe(false);
  }
}

/** No chunk contains a `<` whose matching `>` is in a later chunk (broken tag). */
function expectNoBrokenTag(parts: readonly string[]): void {
  for (const part of parts) {
    const lastOpen = part.lastIndexOf('<');
    if (lastOpen !== -1) {
      expect(part.indexOf('>', lastOpen)).toBeGreaterThan(lastOpen);
    }
  }
}

/** No chunk ends mid-entity: a trailing `&` without its closing `;` in-chunk. */
function expectNoBrokenEntity(parts: readonly string[]): void {
  for (const part of parts) {
    const lastAmp = part.lastIndexOf('&');
    if (lastAmp !== -1) {
      const semi = part.indexOf(';', lastAmp);
      // Either the entity closes within this chunk, OR what follows `&` is plainly
      // not an entity start (e.g. a space) so it cannot be a truncated entity.
      const closes = semi > lastAmp;
      const notEntity = !/^&[a-zA-Z#][a-zA-Z0-9#]*$/.test(part.slice(lastAmp));
      expect(closes || notEntity).toBe(true);
    }
  }
}

describe('splitHtmlMessage — boundary straddle (CRITICAL correctness)', () => {
  it('[edge] an exactly-4096 input returns a single unchanged chunk', () => {
    const html = 'x'.repeat(LIMIT);
    const parts = splitHtmlMessage(html);
    expect(parts).toEqual([html]);
  });

  it('[edge] a 4097-char input (just over) splits into two chunks that reassemble', () => {
    const html = 'x'.repeat(LIMIT + 1);
    const parts = splitHtmlMessage(html);
    expect(parts).toHaveLength(2);
    expect(parts[0]?.length).toBe(LIMIT);
    expect(parts[1]?.length).toBe(1);
    expect(parts.join('')).toBe(html);
  });

  it('[adv] a surrogate pair straddling 4096 is not split into a lone surrogate', () => {
    // Place the high surrogate at index 4095 and the low at 4096 so the naive cut
    // at 4096 would orphan the high surrogate.
    const head = '字'.repeat(LIMIT - 1); // each CJK char = 1 code unit
    const html = `${head}😀 后续报告内容继续`; // 😀 = D83D DE00, straddles 4095/4096
    const parts = splitHtmlMessage(html);
    expectAllWithinLimit(parts);
    expectNoLoneSurrogates(parts);
    expect(parts.join('')).toBe(html);
    expect(parts.join('')).toContain('😀');
  });

  it('[adv] an HTML tag straddling 4096 is pulled left and kept intact', () => {
    // Drive a long tag so its `<` is before 4096 and its `>` after.
    const head = 'a'.repeat(LIMIT - 5);
    const html = `${head}<a href="https://example.com/very/long/path">链接文字</a> 尾部`;
    const parts = splitHtmlMessage(html);
    expectAllWithinLimit(parts);
    expectNoBrokenTag(parts);
    expect(parts.join('')).toBe(html);
    // The full anchor tag must appear contiguously in exactly one chunk.
    expect(parts.some((p) => p.includes('<a href="https://example.com/very/long/path">'))).toBe(true);
  });

  it('[adv] an &amp; entity straddling 4096 is not cut mid-entity', () => {
    // `&amp;` (5 code units) placed so `&` is at 4094 and `;` at 4098.
    const head = 'b'.repeat(LIMIT - 2);
    const html = `${head}&amp;继续`;
    const parts = splitHtmlMessage(html);
    expectAllWithinLimit(parts);
    expectNoBrokenEntity(parts);
    expect(parts.join('')).toBe(html);
    expect(parts.some((p) => p.includes('&amp;'))).toBe(true);
  });

  it('[adv] a long numeric entity &#127881; straddling 4096 is kept whole', () => {
    const head = 'c'.repeat(LIMIT - 3);
    const html = `${head}&#127881;庆祝`;
    const parts = splitHtmlMessage(html);
    expectAllWithinLimit(parts);
    expectNoBrokenEntity(parts);
    expect(parts.join('')).toBe(html);
    expect(parts.some((p) => p.includes('&#127881;'))).toBe(true);
  });
});

describe('splitHtmlMessage — pathological / forced progress (no infinite loop)', () => {
  it('[adv] an unterminated `<` longer than the limit forces one code unit progress (terminates)', () => {
    // A `<` with no `>` for the whole window collapses the tag guard to zero; the
    // splitter must still terminate by forcing progress, not hang.
    const html = `<${'z'.repeat(LIMIT + 50)}`; // `<` then 4146 z's, no `>`
    const parts = splitHtmlMessage(html);
    expect(parts.length).toBeGreaterThan(0);
    expectAllWithinLimit(parts);
    expect(parts.join('')).toBe(html);
  });

  it('[adv] a single unbreakable token (one `<` then >4096 chars, never closed) reassembles exactly', () => {
    const html = `<${'w'.repeat(LIMIT * 2)}`;
    const parts = splitHtmlMessage(html);
    expectAllWithinLimit(parts);
    expect(parts.join('')).toBe(html);
  });

  it('[adv] an unterminated `&` entity longer than the limit still terminates and reassembles', () => {
    const html = `&${'amp'.repeat(LIMIT)}`; // `&` then a huge run with no `;`
    const parts = splitHtmlMessage(html);
    expectAllWithinLimit(parts);
    expect(parts.join('')).toBe(html);
  });
});

describe('splitHtmlMessage — large realistic content invariants', () => {
  it('[edge] a 12000-char mixed HTML report reassembles and every chunk is valid', () => {
    // Realistic agent output: paragraphs with bold tags, entities, CJK, and emoji.
    const paragraph =
      '<b>数据库选型评估</b>：读多写少建议 SQLite，写密集建议 Postgres。' +
      '注意并发上限 &amp; 备份策略 🐱 — 详见 <a href="https://e.com/db?x=1&amp;y=2">基准</a>。';
    let html = '';
    while (html.length < 12000) html += paragraph;
    const parts = splitHtmlMessage(html);

    expect(parts.length).toBeGreaterThan(2);
    expectAllWithinLimit(parts);
    expectNoLoneSurrogates(parts);
    expectNoBrokenTag(parts);
    expectNoBrokenEntity(parts);
    expect(parts.join('')).toBe(html);
  });

  it('[edge] every boundary on a long emoji-dense string keeps pairs intact', () => {
    // Dense surrogate pairs maximize the chance of an orphan at any cut point.
    const html = '🎉🐱😀👍🔥'.repeat(2000); // 5 emoji * 2 units * 2000 = 20000 code units
    const parts = splitHtmlMessage(html);
    expectAllWithinLimit(parts);
    expectNoLoneSurrogates(parts);
    expect(parts.join('')).toBe(html);
    // No emoji was destroyed: code-point count is preserved across the join.
    expect([...parts.join('')].length).toBe([...html].length);
  });
});
