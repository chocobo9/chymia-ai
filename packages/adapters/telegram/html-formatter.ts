// M14 html-formatter — convert agent markdown into Telegram-safe HTML.
//
// Source: clowder-architecture-design.md §7.8 (消息格式用 Telegram HTML
// `<b>` `<i>` `<code>`). Telegram's HTML parse mode supports a small tag subset
// and requires `< > &` in TEXT to be escaped to entities; an unescaped `<` is a
// parse error that rejects the whole message. Agents emit Markdown, so we map a
// safe Markdown subset → the allowed Telegram tags and escape everything else.
//
// Supported tags (Telegram HTML mode): <b> <i> <code> <pre> <a href>.
// Pattern from Clowder telegram-html-formatter.ts (the `esc` escaping shape).

/**
 * Escape the three characters Telegram's HTML parser treats specially in text
 * nodes. Order matters: `&` MUST be escaped first or it would double-escape the
 * `&` introduced by `<`/`>` replacements.
 * Pattern from Clowder telegram-html-formatter.ts.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** A resolved inline/block span the formatter has already converted to final HTML. */
interface Segment {
  readonly html: string;
}

/**
 * Extract fenced code blocks (```...```) and inline code (`...`) FIRST, holding
 * them aside as finished `<pre>` / `<code>` segments so their contents are never
 * interpreted as bold/italic/link markup. Returns the segments interleaved with
 * the still-unprocessed plain-text gaps (as raw, un-escaped strings).
 */
function tokenizeCode(markdown: string): ReadonlyArray<Segment | { readonly text: string }> {
  const out: Array<Segment | { readonly text: string }> = [];
  // Fenced blocks first, then inline spans, scanning left to right.
  const pattern = /```([\s\S]*?)```|`([^`\n]+)`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    if (match.index > lastIndex) {
      out.push({ text: markdown.slice(lastIndex, match.index) });
    }
    const fenced = match[1];
    const inline = match[2];
    if (fenced !== undefined) {
      out.push({ html: `<pre>${escapeHtml(fenced.replace(/^\n/, '').replace(/\n$/, ''))}</pre>` });
    } else if (inline !== undefined) {
      out.push({ html: `<code>${escapeHtml(inline)}</code>` });
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < markdown.length) {
    out.push({ text: markdown.slice(lastIndex) });
  }
  return out;
}

/**
 * Convert the inline markup of a plain-text gap (no code spans remain here) into
 * Telegram HTML: links → `<a>`, bold → `<b>`, italic → `<i>`. The literal text
 * captured by each pattern is escaped so user `< > &` can never inject markup.
 */
function formatInline(text: string): string {
  // Links: [label](url). Escape label as text; escape url inside the attribute.
  const html = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_all, label: string, url: string) => {
    return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
  });
  // Split on the link tags so we don't escape the markup we just produced, then
  // escape + apply emphasis only to the text spans between them.
  return html
    .split(/(<a href="[^"]*">[^<]*<\/a>)/)
    .map((piece) => (piece.startsWith('<a href=') ? piece : emphasizeText(piece)))
    .join('');
}

/**
 * Escape a raw text run, then translate `**bold**` → `<b>` and `*italic*` /
 * `_italic_` → `<i>` on the ESCAPED string (the markers are ASCII and survive
 * escaping unchanged, so we never produce tags around attacker-supplied `<`).
 */
function emphasizeText(raw: string): string {
  const escaped = escapeHtml(raw);
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<i>$1</i>')
    .replace(/(?<![\w])_([^_\n]+)_(?![\w])/g, '<i>$1</i>');
}

/**
 * Format agent Markdown into a single Telegram-HTML string safe for HTML parse
 * mode. Code/pre spans are isolated first (their bodies escaped but not emphasized),
 * then the remaining text gaps get link + bold + italic conversion with full
 * `< > &` escaping. Plain text with no markup round-trips to escaped plain text.
 *
 * @param markdown Agent reply text (Markdown subset).
 * @returns Telegram-HTML payload (caller splits it with splitHtmlMessage).
 */
export function formatToTelegramHtml(markdown: string): string {
  return tokenizeCode(markdown)
    .map((seg) => ('html' in seg ? seg.html : formatInline(seg.text)))
    .join('');
}
