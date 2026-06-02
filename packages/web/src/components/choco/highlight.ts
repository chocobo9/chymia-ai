// highlight — a lightweight, dependency-free syntax highlighter for the code
// shown when an agent calls a code-editing tool (Edit/Write → a <Diff>). It is
// deliberately NOT a full language parser: it tokenizes a single line into
// comment / string / number / keyword / plain spans — enough to color a diff the
// way an editor would, WITHOUT pulling in a heavy grammar+theme dependency
// (shiki/prism), matching the project's "no new deps" stance. Pure and
// deterministic so it is unit-testable; the concatenation of the emitted token
// texts always equals the input line EXACTLY (no characters dropped — essential
// because the diff body renders with `white-space: pre`).

/** A highlighted span. `cls`, when set, maps to a `.tk-<cls>` CSS color class. */
export interface CodeToken {
  readonly text: string;
  readonly cls?: 'kw' | 'str' | 'com' | 'num';
}

/** Coarse language family — drives the comment style + keyword set. */
export type CodeLang = 'js' | 'py' | 'shell' | 'generic';

/** TypeScript/JavaScript keyword + built-in-literal set. */
const JS_KEYWORDS: ReadonlySet<string> = new Set([
  'abstract', 'any', 'as', 'async', 'await', 'boolean', 'break', 'case', 'catch',
  'class', 'const', 'continue', 'debugger', 'declare', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from',
  'function', 'get', 'if', 'implements', 'import', 'in', 'infer', 'instanceof',
  'interface', 'is', 'keyof', 'let', 'namespace', 'never', 'new', 'null',
  'number', 'object', 'of', 'private', 'protected', 'public', 'readonly',
  'return', 'satisfies', 'set', 'static', 'string', 'super', 'switch', 'symbol',
  'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'unknown', 'var',
  'void', 'while', 'with', 'yield',
]);

/** Python keyword + built-in-literal set. */
const PY_KEYWORDS: ReadonlySet<string> = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
  'del', 'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global',
  'if', 'import', 'in', 'is', 'lambda', 'None', 'nonlocal', 'not', 'or', 'pass',
  'raise', 'return', 'self', 'True', 'try', 'while', 'with', 'yield', 'match',
  'case',
]);

/** Broad C-like set covering go/rust/java/c/c++/json literals (the fallback). */
const GENERIC_KEYWORDS: ReadonlySet<string> = new Set([
  'auto', 'bool', 'break', 'case', 'catch', 'char', 'class', 'const', 'continue',
  'default', 'defer', 'delete', 'do', 'double', 'else', 'enum', 'export',
  'extends', 'false', 'final', 'float', 'fn', 'for', 'func', 'go', 'goto', 'if',
  'impl', 'import', 'int', 'interface', 'let', 'long', 'match', 'mut',
  'namespace', 'new', 'nil', 'null', 'package', 'private', 'protected', 'pub',
  'public', 'return', 'self', 'short', 'sizeof', 'static', 'struct', 'switch',
  'template', 'this', 'throw', 'trait', 'true', 'try', 'type', 'typedef',
  'typeof', 'union', 'unsigned', 'use', 'var', 'virtual', 'void', 'volatile',
  'while',
]);

/** Languages whose line comments start with `#` (rather than `//`). */
const HASH_COMMENT_EXTS: ReadonlySet<string> = new Set([
  'py', 'pyi', 'sh', 'bash', 'zsh', 'fish', 'rb', 'yml', 'yaml', 'toml', 'ini',
  'conf', 'cfg', 'dockerfile',
]);

/** Map a file path/extension to a coarse language family for highlighting. */
export function langFromPath(path: string): CodeLang {
  const dot = path.lastIndexOf('.');
  const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'].includes(ext)) return 'js';
  if (['py', 'pyi'].includes(ext)) return 'py';
  if (HASH_COMMENT_EXTS.has(ext)) return 'shell';
  return 'generic';
}

function keywordSet(lang: CodeLang): ReadonlySet<string> {
  if (lang === 'js') return JS_KEYWORDS;
  if (lang === 'py') return PY_KEYWORDS;
  return GENERIC_KEYWORDS;
}

function usesHashComments(lang: CodeLang): boolean {
  return lang === 'py' || lang === 'shell';
}

// Token source pieces, ordered so the longest/most-specific alternative wins.
// Group 1 = comment, 2 = string, 3 = number, 4 = identifier. Anything else
// (operators, punctuation, whitespace) is emitted as an uncolored gap.
const STRING_SRC = String.raw`("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\`(?:\\.|[^\`\\])*\`)`;
const NUMBER_SRC = String.raw`(\b0[xX][0-9a-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)`;
const IDENT_SRC = String.raw`([A-Za-z_$][\w$]*)`;

/** Build the per-language tokenizer source (comment alternative varies). */
function tokenizerSource(lang: CodeLang): string {
  const commentSrc = usesHashComments(lang)
    ? String.raw`(#[^\n]*)`
    : String.raw`(\/\/[^\n]*|\/\*[\s\S]*?\*\/)`;
  return `${commentSrc}|${STRING_SRC}|${NUMBER_SRC}|${IDENT_SRC}`;
}

/**
 * Tokenize one line of `code` for the given `lang` into highlight spans.
 * Returns plain (uncolored) tokens for whitespace/operators/punctuation and the
 * leading diff marker (`+`/`-`), which is fine — those inherit the line color.
 */
export function highlightCode(code: string, lang: CodeLang): readonly CodeToken[] {
  const re = new RegExp(tokenizerSource(lang), 'g');
  const keywords = keywordSet(lang);
  const tokens: CodeToken[] = [];
  let last = 0;
  let match: RegExpExecArray | null = re.exec(code);
  while (match !== null) {
    if (match.index > last) tokens.push({ text: code.slice(last, match.index) });
    const text = match[0];
    let cls: CodeToken['cls'];
    if (match[1] !== undefined) cls = 'com';
    else if (match[2] !== undefined) cls = 'str';
    else if (match[3] !== undefined) cls = 'num';
    else if (match[4] !== undefined && keywords.has(text)) cls = 'kw';
    tokens.push(cls === undefined ? { text } : { text, cls });
    last = match.index + text.length;
    if (text.length === 0) re.lastIndex += 1; // guard against any zero-width match
    match = re.exec(code);
  }
  if (last < code.length) tokens.push({ text: code.slice(last) });
  return tokens;
}
