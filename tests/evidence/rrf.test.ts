// M6 dev tests (happy path) — Reciprocal Rank Fusion.
// QA owns edge/adversarial coverage.

import { test, expect } from 'vitest';
import { fuseByRrf, RRF_K, type RankedList } from '../../packages/api/src/evidence/rrf.js';

test('unit: RRF constant k is 60 (standard)', () => {
  expect(RRF_K).toBe(60);
});

test('unit: fuseByRrf ranks an anchor present in both lists above single-list anchors', () => {
  // Arrange — 'evidence:vector-retrieval' appears in both lexical and semantic.
  const lexical: RankedList = {
    anchors: ['evidence:fts5-bm25', 'evidence:vector-retrieval', 'evidence:wal-mode'],
  };
  const semantic: RankedList = {
    anchors: ['evidence:vector-retrieval', 'evidence:embedding-dim', 'evidence:fts5-bm25'],
  };

  // Act
  const fused = fuseByRrf([lexical, semantic]);

  // Assert — the doubly-ranked anchor wins on accumulated score.
  expect(fused[0].anchor).toBe('evidence:vector-retrieval');
  expect(fused[0].score).toBeGreaterThan(fused[1].score);
});

test('unit: fuseByRrf de-duplicates anchors appearing in multiple lists', () => {
  // Arrange
  const a: RankedList = { anchors: ['decision:db-choice', 'decision:cache-layer'] };
  const b: RankedList = { anchors: ['decision:db-choice', 'decision:cache-layer'] };

  // Act
  const fused = fuseByRrf([a, b]);

  // Assert — only two unique anchors, no repeats.
  const anchors = fused.map((f) => f.anchor);
  expect(anchors).toHaveLength(2);
  expect(new Set(anchors).size).toBe(2);
});

test('unit: fuseByRrf score equals sum of 1/(k+rank+1) across lists', () => {
  // Arrange — single anchor at rank 0 in both lists.
  const list1: RankedList = { anchors: ['research:rrf-paper'] };
  const list2: RankedList = { anchors: ['research:rrf-paper'] };

  // Act
  const fused = fuseByRrf([list1, list2]);

  // Assert — 1/(60+0+1) twice.
  const expected = 1 / (RRF_K + 1) + 1 / (RRF_K + 1);
  expect(fused[0].score).toBeCloseTo(expected, 10);
});
