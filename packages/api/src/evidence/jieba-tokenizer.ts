// jieba pre-tokenization layer for FTS5.
//
// Source: clowder-architecture-design.md §4.5 / §7.6 — "用 jieba 对 query 和
// evidence 内容预分词，存入 FTS5"。"混合 CJK+ASCII 时，jieba 只切 CJK，ASCII 按
// 空格/标点切。"
//
// WHY this replaces the reference: Clowder's fts-tokenize.ts applied a
// CJK_NN_WEIGHT (0.3) down-weight + bigram split on Chinese terms instead of
// real word segmentation, so "数据库" would not cleanly match "数据库选型".
// We segment with jieba so the FTS5 unicode61 tokenizer sees space-separated
// Chinese words and Chinese lexical recall works like ASCII.

import { Jieba } from '@node-rs/jieba';

// Unicode ranges covering CJK Unified Ideographs + Extension A.
// Source: fts-tokenize.ts CJK_RANGE (reference) — same ranges, re-authored.
const CJK_RANGE = /[㐀-䶿一-鿿]/;

// Module-level singleton: the segmenter is pure (no per-call state) and the
// dictionary load is expensive, so we build it lazily once and reuse it.
// Allowed by spec ("module-level singleton is fine for a pure tokenizer").
let segmenter: Jieba | undefined;

function getSegmenter(): Jieba {
  if (segmenter === undefined) {
    segmenter = new Jieba();
  }
  return segmenter;
}

/**
 * hasCJK — true if the string contains at least one CJK ideograph.
 * Used to decide whether jieba segmentation is worth running.
 */
export function hasCJK(text: string): boolean {
  return CJK_RANGE.test(text);
}

/**
 * tokenizeForIndex — segment arbitrary (possibly mixed CJK+ASCII) text into a
 * space-joined token string suitable for storage in an FTS5 column.
 *
 * - jieba.cut splits CJK into words and leaves ASCII runs/punctuation as their
 *   own tokens; we drop pure-whitespace fragments and trim each token.
 * - The result is whitespace-joined so the FTS5 unicode61 tokenizer indexes
 *   each segmented word independently.
 *
 * Called on BOTH upsert content and (via tokenizeForQuery) the search query so
 * indexed and queried token boundaries match.
 */
export function tokenizeForIndex(text: string): string {
  if (text.length === 0) {
    return '';
  }
  // hmm=true enables the HMM model for unknown/new-word discovery.
  const pieces = getSegmenter().cut(text, true);
  return joinTokens(pieces);
}

/**
 * tokenizeForQuery — produce a safe FTS5 MATCH expression from a raw query.
 *
 * Each segmented token is wrapped in double quotes (FTS5 phrase syntax) so
 * special FTS5 operator characters in user input cannot break the query, and
 * tokens are OR-ed: any token may match. Returns '' when the query yields no
 * usable tokens (caller treats that as "no lexical hits").
 *
 * Pattern from Clowder fts-tokenize.ts buildFtsMatchQuery (quote-and-OR), but
 * fed jieba-segmented tokens instead of raw/bigram terms.
 */
export function tokenizeForQuery(query: string): string {
  const tokens = tokenizeForIndex(query)
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => escapeFtsToken(t));
  if (tokens.length === 0) {
    return '';
  }
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

// Collapse jieba pieces into a normalized space-joined string, dropping
// whitespace-only fragments.
function joinTokens(pieces: readonly string[]): string {
  const cleaned: string[] = [];
  for (const piece of pieces) {
    const trimmed = piece.trim();
    if (trimmed.length > 0) {
      cleaned.push(trimmed);
    }
  }
  return cleaned.join(' ');
}

// Escape embedded double quotes so a token never terminates the FTS5 phrase
// early. FTS5 escapes a literal " inside a phrase by doubling it.
function escapeFtsToken(token: string): string {
  return token.replace(/"/g, '""');
}
