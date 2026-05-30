/**
 * DSL value-template lexer.
 *
 * Tokenises a template string into TEXT / EXPR / ESCAPED lexemes per the
 * template grammar (docs/grammar/cel.grammar.md §3). The opening delimiters
 * `${` and `$${` are recognised by direct character inspection; the matching
 * close brace is located by brace-depth counting (so a `${...}` body may itself
 * contain `{` `}` and quoted strings). No regex parses template structure.
 */

export interface Position {
  readonly line: number;
  readonly col: number;
  readonly offset: number;
}

export type TemplateToken =
  | { type: 'TEXT';    text: string; pos: Position }
  | { type: 'EXPR';    src: string;  pos: Position }   // CEL source inside ${...}
  | { type: 'ESCAPED'; text: string; pos: Position };  // literal "${...}" body

export class TemplateLexError extends Error {
  constructor(message: string, readonly pos: Position) {
    super(message);
    this.name = 'TemplateLexError';
  }
}

/**
 * Find the index of the brace that closes a `${`/`$${` opened just before
 * `start` (depth begins at 1). Returns -1 if unbalanced. Quote handling is not
 * needed for matching because CEL string literals cannot contain a raw `{`/`}`
 * that would unbalance — but to be safe and to mirror the legacy
 * `findClosingBrace`, we count braces directly (legacy did the same).
 */
function findClosingBrace(s: string, start: number): number {
  let depth = 1;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Tokenise a template string. */
export function lexTemplate(s: string): TemplateToken[] {
  const tokens: TemplateToken[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  let buf = '';
  let bufPos: Position = { line, col, offset: 0 };

  const posAt = (offset: number): Position => ({ line, col, offset });

  const flushText = (): void => {
    if (buf.length > 0) {
      tokens.push({ type: 'TEXT', text: buf, pos: bufPos });
      buf = '';
    }
  };

  const startBuf = (): void => { if (buf.length === 0) bufPos = posAt(i); };

  const advanceCols = (text: string): void => {
    for (const ch of text) {
      if (ch === '\n') { line++; col = 1; } else { col++; }
    }
  };

  while (i < s.length) {
    // Escaped interpolation: $${ body } → literal "${body}".
    if (s[i] === '$' && s[i + 1] === '$' && s[i + 2] === '{') {
      const close = findClosingBrace(s, i + 3);
      if (close === -1) {
        // Unbalanced — treat the '$' as plain text (legacy fallback).
        startBuf();
        buf += s[i];
        advanceCols(s[i]!);
        i++;
        continue;
      }
      flushText();
      const body = s.slice(i + 3, close);
      tokens.push({ type: 'ESCAPED', text: body, pos: posAt(i) });
      advanceCols(s.slice(i, close + 1));
      i = close + 1;
      continue;
    }

    // Interpolation: ${ expr }.
    if (s[i] === '$' && s[i + 1] === '{') {
      const close = findClosingBrace(s, i + 2);
      if (close === -1) {
        startBuf();
        buf += s[i];
        advanceCols(s[i]!);
        i++;
        continue;
      }
      flushText();
      const src = s.slice(i + 2, close);
      tokens.push({ type: 'EXPR', src, pos: posAt(i) });
      advanceCols(s.slice(i, close + 1));
      i = close + 1;
      continue;
    }

    startBuf();
    buf += s[i];
    advanceCols(s[i]!);
    i++;
  }
  flushText();
  return tokens;
}
