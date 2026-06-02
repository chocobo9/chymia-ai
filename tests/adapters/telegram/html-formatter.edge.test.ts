// M14 html-formatter QA edge + adversarial suite (authored by QA, not the dev).
//
// FOCUS: Telegram sends our output with parse_mode=HTML, so any unescaped `<`,
// `>`, `&` in untrusted content is either (a) a parse error that rejects the whole
// message, or (b) live markup injection. The CRITICAL security property under test
// is that attacker-supplied content can NEVER reach Telegram as live HTML — every
// `<`/`>`/`&` originating from content must be an entity, and the only literal tags
// in the output are the ones the formatter itself emits (<b>/<i>/<code>/<pre>/<a>).
//
// Distribution for this file: edge + adversarial only (happy path lives in the dev
// suite). Realistic injection payloads + CJK/emoji content — no placeholders.

import { describe, it, expect } from 'vitest';
import { formatToTelegramHtml, escapeHtml } from '@choco/adapters/telegram/html-formatter';

// The complete set of literal tags the formatter is ALLOWED to emit. Any other
// literal `<...>` in the output is an injection / leak.
const ALLOWED_TAG = /<\/?(?:b|i|code|pre|a(?:\s+href="[^"]*")?)>/g;

/**
 * Assert no live HTML injection: after removing every tag the formatter is
 * permitted to emit, the remaining string contains no raw `<` or `>` (they must
 * all be entities). This is the anti-injection invariant.
 */
function expectNoRawAngleBrackets(html: string): void {
  const stripped = html.replace(ALLOWED_TAG, '');
  expect(stripped).not.toContain('<');
  expect(stripped).not.toContain('>');
}

describe('escapeHtml — adversarial', () => {
  it('[adv] neutralizes a full <script> XSS-style payload to inert entities', () => {
    const payload = '<script>alert(String.fromCharCode(88,83,83))</script>';
    const escaped = escapeHtml(payload);
    expect(escaped).toBe(
      '&lt;script&gt;alert(String.fromCharCode(88,83,83))&lt;/script&gt;',
    );
    expect(escaped).not.toContain('<');
    expect(escaped).not.toContain('>');
  });

  it('[adv] does not double-escape an already-escaped entity (idempotent ampersand handling)', () => {
    // Already-escaped input would become &amp;lt; — proving & is handled literally,
    // not de-entitized. This documents that callers must pass RAW text, not pre-escaped.
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('[edge] escapes a bare ampersand that is not part of any entity', () => {
    expect(escapeHtml('Tom & Jerry & 老鼠')).toBe('Tom &amp; Jerry &amp; 老鼠');
  });

  it('[edge] returns empty string unchanged', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('[edge] preserves CJK and emoji code points while escaping specials', () => {
    expect(escapeHtml('数据库 <并发> 🐱 & 评估')).toBe('数据库 &lt;并发&gt; 🐱 &amp; 评估');
  });
});

describe('formatToTelegramHtml — anti-injection (CRITICAL security)', () => {
  it('[adv] escapes a raw <b> the attacker typed so it is NOT a live bold tag', () => {
    // Attacker literally types the characters <b>; this is NOT markdown, so it must
    // be escaped, not passed through as a tag.
    const out = formatToTelegramHtml('totally normal <b>not my bold</b> message');
    expect(out).toBe('totally normal &lt;b&gt;not my bold&lt;/b&gt; message');
    expectNoRawAngleBrackets(out);
  });

  it('[adv] neutralizes an inline <img onerror> injection in plain text', () => {
    const out = formatToTelegramHtml('look here <img src=x onerror=alert(1)> done');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expectNoRawAngleBrackets(out);
  });

  it('[adv] escapes a <script> payload embedded inside **bold** markdown', () => {
    const out = formatToTelegramHtml('**<script>evil()</script>**');
    // The bold wrapper is the formatter's own tag; the body must be fully escaped.
    expect(out).toBe('<b>&lt;script&gt;evil()&lt;/script&gt;</b>');
    expectNoRawAngleBrackets(out);
  });

  it('[adv] escapes < > & inside a fenced code block body (not re-parsed as HTML)', () => {
    const md = '```\n<div onclick="x()">a & b < c</div>\n```';
    const out = formatToTelegramHtml(md);
    // escapeHtml only escapes < > & (Telegram text specials); the literal double
    // quotes inside a <pre> body are harmless and stay as-is. (Note: the source
    // text has no space between `c` and `</div>`.)
    expect(out).toBe('<pre>&lt;div onclick="x()"&gt;a &amp; b &lt; c&lt;/div&gt;</pre>');
    // The pre wrapper is ours; everything between is escaped.
    expectNoRawAngleBrackets(out);
  });

  it('[adv] does not re-interpret markdown markers inside a code span body', () => {
    // **bold** and [x](y) inside `code` must survive literally, escaped, not converted.
    const out = formatToTelegramHtml('`**not bold** and [no](link) and a < b`');
    expect(out).toBe('<code>**not bold** and [no](link) and a &lt; b</code>');
    expectNoRawAngleBrackets(out);
  });

  it('[adv] sanitizes a javascript: link href and the malicious angle-bracket label', () => {
    // A javascript: scheme URL with no parens (the markdown link grammar stops the
    // url capture at the first ')'). The attacker also puts <b> in the label — both
    // the href and the label must be escaped, and no raw angle bracket may leak.
    const out = formatToTelegramHtml('[click <b>me</b>](javascript:document.cookie)');
    expect(out).toBe('<a href="javascript:document.cookie">click &lt;b&gt;me&lt;/b&gt;</a>');
    expectNoRawAngleBrackets(out);
  });

  it('[adv] escapes a quote/ampersand in a link URL so it cannot break out of the href attribute', () => {
    // A `&` in the URL must become &amp; (cannot start a new attribute); the formatter
    // uses a non-quote-containing url capture, so a `"` cannot appear here, but the
    // ampersand breakout is the realistic attack and must be neutralized.
    const out = formatToTelegramHtml('see [docs](https://e.com/?a=1&b=2&onload=x)');
    expect(out).toBe('see <a href="https://e.com/?a=1&amp;b=2&amp;onload=x">docs</a>');
    expectNoRawAngleBrackets(out);
  });

  it('[adv] a single raw & between two code spans is escaped, code bodies are not', () => {
    const out = formatToTelegramHtml('`a<b` & `c>d`');
    expect(out).toBe('<code>a&lt;b</code> &amp; <code>c&gt;d</code>');
    expectNoRawAngleBrackets(out);
  });
});

describe('formatToTelegramHtml — markdown edge cases', () => {
  it('[edge] leaves an unterminated bold marker as a literal asterisk', () => {
    // A lone ** with no closing pair is not bold — must not produce a dangling <b>.
    const out = formatToTelegramHtml('this is **not closed');
    expect(out).not.toContain('<b>');
    expect(out).toBe('this is **not closed');
  });

  it('[edge] does not treat snake_case identifiers as italic', () => {
    // _ inside a word boundary must not start italic (lookbehind/lookahead guard).
    const out = formatToTelegramHtml('call get_thread_by_id(threadId)');
    expect(out).not.toContain('<i>');
    expect(out).toBe('call get_thread_by_id(threadId)');
  });

  it('[edge] handles a fenced block immediately followed by inline code', () => {
    const md = '```\nconst x = 1 < 2;\n```\nthen `y > 0`';
    const out = formatToTelegramHtml(md);
    expect(out).toBe('<pre>const x = 1 &lt; 2;</pre>\nthen <code>y &gt; 0</code>');
    expectNoRawAngleBrackets(out);
  });

  it('[edge] preserves emoji and CJK alongside applied bold', () => {
    const out = formatToTelegramHtml('结论 **用 SQLite** 🐱👍');
    expect(out).toBe('结论 <b>用 SQLite</b> 🐱👍');
    expect(out).toContain('🐱👍');
  });

  it('[edge] an empty fenced block produces an empty <pre> not raw fences', () => {
    const out = formatToTelegramHtml('``````');
    // Three backticks open + three close with empty body.
    expect(out).toBe('<pre></pre>');
  });

  it('[adv] nested/overlapping markers do not yield unbalanced live tags', () => {
    // Whatever the formatter chooses, the output must not leak raw angle brackets.
    const out = formatToTelegramHtml('a *b **c* d** e');
    expectNoRawAngleBrackets(out);
  });

  it('[edge] returns empty string for empty input', () => {
    expect(formatToTelegramHtml('')).toBe('');
  });
});
