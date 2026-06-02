// M14 html-formatter dev happy-path suite. QA owns edge + adversarial coverage.
//
// Verifies the Markdown→Telegram-HTML mapping for the supported tag subset and
// that text-node `< > &` are escaped to entities. Real agent-style markdown +
// CJK content — no placeholders.

import { describe, it, expect } from 'vitest';
import { formatToTelegramHtml, escapeHtml } from '@choco/adapters/telegram/html-formatter';

describe('escapeHtml (happy path)', () => {
  it('escapes the three Telegram-special characters to entities', () => {
    // Arrange
    const raw = 'if a < b && b > c then panic';

    // Act
    const escaped = escapeHtml(raw);

    // Assert
    expect(escaped).toBe('if a &lt; b &amp;&amp; b &gt; c then panic');
  });

  it('escapes & before < and > so entities are not double-escaped', () => {
    expect(escapeHtml('<tag> & </tag>')).toBe('&lt;tag&gt; &amp; &lt;/tag&gt;');
  });
});

describe('formatToTelegramHtml (happy path)', () => {
  it('converts **bold** to <b>', () => {
    expect(formatToTelegramHtml('请先看 **读写比例** 再决策')).toBe(
      '请先看 <b>读写比例</b> 再决策',
    );
  });

  it('converts *italic* and _italic_ to <i>', () => {
    expect(formatToTelegramHtml('this is *important* and _also this_')).toBe(
      'this is <i>important</i> and <i>also this</i>',
    );
  });

  it('converts inline `code` to <code> and escapes its body', () => {
    expect(formatToTelegramHtml('run `SELECT * FROM users WHERE a < b`')).toBe(
      'run <code>SELECT * FROM users WHERE a &lt; b</code>',
    );
  });

  it('converts a fenced ```block``` to <pre> with the body escaped', () => {
    const md = '```\nif (a < b) return a & b;\n```';
    expect(formatToTelegramHtml(md)).toBe('<pre>if (a &lt; b) return a &amp; b;</pre>');
  });

  it('converts [label](url) to an <a href> with label and url escaped', () => {
    expect(formatToTelegramHtml('see [the docs](https://example.com/q?a=1&b=2)')).toBe(
      'see <a href="https://example.com/q?a=1&amp;b=2">the docs</a>',
    );
  });

  it('escapes literal < > & in plain CJK text with no markup', () => {
    expect(formatToTelegramHtml('Postgres 还是 SQLite？比较 <并发> 与读写比例')).toBe(
      'Postgres 还是 SQLite？比较 &lt;并发&gt; 与读写比例',
    );
  });

  it('does not emphasize markdown markers inside a code span', () => {
    expect(formatToTelegramHtml('use `a ** b` not bold')).toBe(
      'use <code>a ** b</code> not bold',
    );
  });

  it('combines bold and inline code in one reply', () => {
    expect(formatToTelegramHtml('**注意**: 调用 `getByThread(threadId)`')).toBe(
      '<b>注意</b>: 调用 <code>getByThread(threadId)</code>',
    );
  });
});
