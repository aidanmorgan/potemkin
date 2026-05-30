/**
 * CEL lexer — a real tokenizer producing typed tokens with 1-based line/column
 * positions and absolute offsets.
 *
 * Regular expressions appear ONLY as single-character lexeme classifiers
 * (digit, identifier-char, whitespace). No regex parses token *structure*.
 *
 * See docs/grammar/cel.grammar.md §1 for the lexical grammar, including the
 * negative-number lexeme rule (§1.1) which this lexer reproduces exactly.
 */

/** Terminal symbol names used by the grammar/parser. */
export type Terminal =
  | 'NUMBER' | 'STRING' | 'BOOL' | 'NULL' | 'IDENT'
  | '==' | '!=' | '<=' | '>=' | '&&' | '||' | '?.' | '?['
  | '<' | '>' | '+' | '-' | '*' | '/' | '%' | '!'
  | '(' | ')' | '[' | ']' | '{' | '}' | ',' | '.' | ':' | '?'
  | 'in'
  | '$end';

export interface Position {
  /** 1-based line. */
  readonly line: number;
  /** 1-based column. */
  readonly col: number;
  /** 0-based absolute offset into the source. */
  readonly offset: number;
}

export interface Token {
  readonly type: Terminal;
  /** Decoded value for value-bearing tokens (string/number/bool/ident). */
  readonly value?: string | number | boolean;
  readonly pos: Position;
}

/** Error carrying a source position (1-based line/col). */
export class LexError extends Error {
  constructor(message: string, readonly pos: Position) {
    super(message);
    this.name = 'LexError';
  }
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const isWs = (c: string): boolean => /\s/.test(c);
const isIdentStart = (c: string): boolean => /[A-Za-z_$]/.test(c);
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);

const TWO_CHAR_OPS = new Set(['==', '!=', '<=', '>=', '&&', '||']);

/**
 * Tokenize CEL source. Throws {@link LexError} (message prefixed with
 * `CEL_TOKENIZE` / `CEL_PARSE_ERROR` to match legacy behaviour) on bad input.
 */
export function lex(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const here = (): Position => ({ line, col, offset: i });

  const advance = (): string => {
    const c = src[i]!;
    i++;
    if (c === '\n') { line++; col = 1; } else { col++; }
    return c;
  };

  while (i < src.length) {
    const c = src[i]!;

    if (isWs(c)) { advance(); continue; }

    // String literals (single / double quoted) with escapes.
    if (c === '"' || c === "'") {
      const start = here();
      const quote = advance();
      let s = '';
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          advance(); // consume backslash
          const esc = i < src.length ? advance() : undefined;
          switch (esc) {
            case 'n': s += '\n'; break;
            case 't': s += '\t'; break;
            case 'r': s += '\r'; break;
            case '\\': s += '\\'; break;
            case '"': s += '"'; break;
            case "'": s += "'"; break;
            default: s += esc ?? ''; break;
          }
        } else {
          s += advance();
        }
      }
      if (i >= src.length) {
        throw new LexError(
          `CEL_PARSE_ERROR: unclosed string literal starting at position ${start.offset}`,
          start,
        );
      }
      advance(); // closing quote
      tokens.push({ type: 'STRING', value: s, pos: start });
      continue;
    }

    // Raw string literals r'...' / r"..." (no escape processing).
    if (c === 'r' && (src[i + 1] === '"' || src[i + 1] === "'")) {
      const start = here();
      advance(); // r
      const quote = advance();
      let s = '';
      while (i < src.length && src[i] !== quote) {
        s += advance();
      }
      if (i >= src.length) {
        throw new LexError(
          `CEL_PARSE_ERROR: unclosed raw string literal starting at position ${start.offset}`,
          start,
        );
      }
      advance(); // closing quote
      tokens.push({ type: 'STRING', value: s, pos: start });
      continue;
    }

    // Numbers. A leading '-' is part of the number ONLY when a digit follows
    // it immediately (legacy negative-number lexeme rule, §1.1).
    if (isDigit(c) || (c === '-' && isDigit(src[i + 1]))) {
      const start = here();
      let n = '';
      if (src[i] === '-') { n += advance(); }
      while (i < src.length && (isDigit(src[i]) || src[i] === '.')) { n += advance(); }
      tokens.push({ type: 'NUMBER', value: parseFloat(n), pos: start });
      continue;
    }

    // Identifiers / keywords.
    if (isIdentStart(c)) {
      const start = here();
      let id = '';
      while (i < src.length && isIdentPart(src[i]!)) { id += advance(); }
      if (id === 'true')  { tokens.push({ type: 'BOOL', value: true,  pos: start }); continue; }
      if (id === 'false') { tokens.push({ type: 'BOOL', value: false, pos: start }); continue; }
      if (id === 'null')  { tokens.push({ type: 'NULL', pos: start }); continue; }
      if (id === 'in')    { tokens.push({ type: 'in',  pos: start }); continue; }
      tokens.push({ type: 'IDENT', value: id, pos: start });
      continue;
    }

    // Two-character operators / null-safe accessors (longest match first).
    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      const start = here();
      advance(); advance();
      tokens.push({ type: two as Terminal, pos: start });
      continue;
    }
    if (two === '?.') { const start = here(); advance(); advance(); tokens.push({ type: '?.', pos: start }); continue; }
    if (two === '?[') { const start = here(); advance(); advance(); tokens.push({ type: '?[', pos: start }); continue; }

    // Single-character tokens.
    const start = here();
    switch (c) {
      case '<': case '>': case '+': case '-': case '*': case '/': case '%': case '!':
      case '(': case ')': case '[': case ']': case '{': case '}':
      case ',': case '.': case ':': case '?':
        advance();
        tokens.push({ type: c as Terminal, pos: start });
        continue;
      default:
        throw new LexError(`CEL_TOKENIZE: unexpected character '${c}' at position ${i}`, start);
    }
  }

  tokens.push({ type: '$end', pos: here() });
  return tokens;
}
