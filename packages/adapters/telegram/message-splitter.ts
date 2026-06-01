// M14 message-splitter — split a Telegram HTML payload at the 4096-char limit
// without breaking an HTML tag, an HTML entity, or a Unicode surrogate pair.
//
// Source: clowder-architecture-design.md §7.8 (Telegram 4096 限制 / HTML 实体安全
// 切割 / surrogate pair 不可分割). Telegram rejects sendMessage payloads over its
// per-message length limit and rejects malformed HTML, so a split point must never
// land in the middle of `<...>`, `&...;`, or a high/low surrogate pair.

/**
 * Telegram's hard per-message text length limit, in UTF-16 code units.
 * Source: Telegram Bot API `sendMessage` `text` constraint (1–4096 chars);
 * mirrors Clowder's TELEGRAM_MAX_MESSAGE_LENGTH. Externalized as a named
 * constant per CLAUDE.md §3.3 (no hardcoded magic numbers).
 */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096 as const;

/** Unicode high-surrogate range start (a code unit pairing with a following low surrogate). */
const HIGH_SURROGATE_MIN = 0xd800;
/** Unicode high-surrogate range end. */
const HIGH_SURROGATE_MAX = 0xdbff;

/**
 * Back up `end` by one code unit when the slice would end on a lone high
 * surrogate (which must stay paired with its following low surrogate).
 * Pattern from Clowder TelegramAdapter.ts (surrogate-safe boundary check).
 */
function avoidSurrogateSplit(text: string, end: number): number {
  const code = text.charCodeAt(end - 1);
  return code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX ? end - 1 : end;
}

/**
 * Pull `end` back to before an HTML entity (`&...;`) that the boundary would
 * otherwise cut in half. Only adjusts when an unterminated `&` started at or
 * after `start` and its closing `;` falls outside the current slice.
 */
function avoidEntitySplit(html: string, start: number, end: number): number {
  const entityStart = html.lastIndexOf('&', end - 1);
  if (entityStart < start) return end;
  const entityEnd = html.indexOf(';', entityStart);
  return entityEnd === -1 || entityEnd >= end ? entityStart : end;
}

/**
 * Pull `end` back to before an HTML tag (`<...>`) that the boundary would
 * otherwise cut in half. Only adjusts when an unterminated `<` started at or
 * after `start` and its closing `>` falls outside the current slice.
 */
function avoidTagSplit(html: string, start: number, end: number): number {
  const tagStart = html.lastIndexOf('<', end - 1);
  if (tagStart < start) return end;
  const tagEnd = html.indexOf('>', tagStart);
  return tagEnd === -1 || tagEnd >= end ? tagStart : end;
}

/**
 * Split a Telegram-HTML string into chunks each ≤ {@link TELEGRAM_MAX_MESSAGE_LENGTH}.
 *
 * A chunk boundary is pulled left so it never lands inside a surrogate pair, an
 * HTML entity, or an HTML tag. If all three guards collapse the window to zero
 * (a tag/entity longer than the limit — pathological), the boundary advances one
 * code unit to guarantee forward progress (never an infinite loop).
 *
 * @param html Telegram-HTML payload (already escaped/formatted upstream).
 * @returns ordered chunks; the input verbatim in a single-element array when it
 *          already fits (empty string → `['']`, so an empty reply still sends).
 */
export function splitHtmlMessage(html: string): readonly string[] {
  if (html.length <= TELEGRAM_MAX_MESSAGE_LENGTH) return [html];

  const parts: string[] = [];
  let start = 0;
  while (start < html.length) {
    let end = Math.min(start + TELEGRAM_MAX_MESSAGE_LENGTH, html.length);
    if (end < html.length) {
      end = avoidSurrogateSplit(html, end);
      end = avoidEntitySplit(html, start, end);
      end = avoidTagSplit(html, start, end);
      // All guards collapsed the window — force one code unit of progress.
      if (end <= start) end = start + 1;
    }
    parts.push(html.slice(start, end));
    start = end;
  }
  return parts;
}
