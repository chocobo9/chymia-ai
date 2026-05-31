// M6 dev tests (happy path) — jieba pre-tokenization layer.
// QA owns edge/adversarial coverage (empty query, only-stopwords, mixed scripts).

import { test, expect } from 'vitest';
import {
  hasCJK,
  tokenizeForIndex,
  tokenizeForQuery,
} from '../../packages/api/src/evidence/jieba-tokenizer.js';

test('unit: hasCJK detects Chinese text and ignores pure ASCII', () => {
  expect(hasCJK('数据库选型')).toBe(true);
  expect(hasCJK('vector retrieval')).toBe(false);
});

test('unit: tokenizeForIndex segments a Chinese term into space-joined words', () => {
  // "数据库选型决定" → 数据库 / 选型 / 决定 ; "数据库" becomes its own token so
  // a "数据库" query can match this content.
  const tokens = tokenizeForIndex('数据库选型决定').split(' ');
  expect(tokens).toContain('数据库');
});

test('unit: tokenizeForIndex keeps ASCII words alongside segmented CJK', () => {
  const out = tokenizeForIndex('采用 SQLite 做 hybrid 检索');
  expect(out).toContain('SQLite');
  expect(out).toContain('hybrid');
  expect(out).toContain('检索');
});

test('unit: tokenizeForQuery builds a quoted OR FTS5 match expression', () => {
  const match = tokenizeForQuery('数据库 检索');
  // Each segmented token is quoted and OR-joined.
  expect(match).toMatch(/"数据库"/);
  expect(match).toContain(' OR ');
});
