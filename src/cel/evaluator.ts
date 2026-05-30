/**
 * CEL evaluator — hand-rolled recursive-descent parser + evaluator.
 *
 * Full Grammar (EBNF, simplified):
 *
 *   expression  = ternary
 *   ternary     = or ( '?' ternary ':' ternary )?
 *   or          = and ( '||' and )*
 *   and         = equality ( '&&' equality )*
 *   equality    = in ( ('==' | '!=') in )*
 *   in_expr     = comparison ( 'in' comparison )*
 *   comparison  = addSub ( ('<' | '<=' | '>' | '>=') addSub )*
 *   addSub      = mulDiv ( ('+' | '-') mulDiv )*
 *   mulDiv      = unary ( ('*' | '/' | '%') unary )*
 *   unary       = ('!' | '-') unary | postfix
 *   postfix     = primary ( '.' ident ( '(' args ')' )?
 *                          | '?.' ident ( '(' args ')' )?
 *                          | '[' expr ']'
 *                          | '?[' expr ']'
 *                          )*
 *   primary     = string | number | bool | null
 *               | ident ( '(' args ')' )?      -- call or identifier
 *               | '(' expr ')'                  -- grouped
 *               | '[' ( expr (',' expr)* ','? )? ']'   -- list literal
 *               | '{' ( entry (',' entry)* ','? )? '}' -- map literal
 *   entry       = expr ':' expr
 *   args        = ( expr (',' expr)* )?
 *
 * Comprehension macros (parsed as method calls on a receiver list):
 *   lst.all(x, pred)       → all elements satisfy pred
 *   lst.exists(x, pred)    → at least one element satisfies pred
 *   lst.exists_one(x, pred)→ exactly one element satisfies pred
 *   lst.filter(x, pred)    → filtered list
 *   lst.map(x, transform)  → mapped list
 *
 * New tokens: '?.' (null-safe dot), '?[' (null-safe bracket)
 *
 * Supported builtins (top-level calls):
 *   $uuidv7, $now, $concat, int, double, string, bool, bytes,
 *   abs, min, max, floor, ceil, round, pow, sqrt,
 *   size, keys, values, range,
 *   type, coalesce, default, timestamp, duration, now
 *
 * Receiver methods:
 *   String: startsWith, endsWith, contains, size, matches, replace, split,
 *           substring, indexOf, lastIndexOf, lowerAscii, upperAscii,
 *           trim, trimStart, trimEnd, charAt
 *   List:   size, contains, indexOf, lastIndexOf, sort, reverse, join,
 *           flatten, distinct
 *   Map:    size, has, keys, values
 */

import { CelPhase } from './phases.js';
import {
  callBuiltin, deepEqual, naturalCompare, createFakeRng,
  type BuiltinContext, type FakeRng,
} from './builtins.js';
import { createLogger } from '../observability/logger.js';

// ---------------------------------------------------------------------------
// ReDoS protection for matches() — synchronous, shape-based guard.
//
// `matches()` runs entirely on the calling thread: there are no Worker threads,
// no Atomics, and no SharedArrayBuffer. An earlier design ran each regex in a
// worker_threads Worker with an Atomics.wait wall-clock timeout; that was
// correct but its blocking + worker-creation overhead caused supertest-driven
// integration tests to flake under jest's parallel worker load (socket
// hang-ups). It has been removed entirely.
//
// Instead, the DSL author is trusted, so we reject patterns whose *shape* is
// known to backtrack catastrophically (nested/overlapping unbounded
// quantifiers) before ever constructing the RegExp, then run the remainder
// synchronously via the native engine. The shape check is O(pattern length),
// independent of input length, so an adversarial pattern is rejected instantly
// rather than hanging the event loop.
// ---------------------------------------------------------------------------

/**
 * Detect a catastrophic-backtracking *shape* in a regex source string.
 *
 * This is a deliberately conservative heuristic (the well-known "safe-regex"
 * family of checks): it looks for an unbounded quantifier (`+`, `*`, or
 * open-ended `{n,}`) applied to a group that itself contains an unbounded
 * quantifier or an overlapping alternation. These are the classic exponential
 * shapes:
 *   - nested quantifier:        (a+)+   (a*)*   (a+)*   (\d+)+
 *   - quantified, open-repeat:  (a+){2,}
 *   - overlapping alternation:  (a|a)+  (a|ab)+
 *
 * @returns a human-readable reason when the pattern looks ReDoS-prone, else null.
 */
function detectCatastrophicRegexShape(pattern: string): string | null {
  // An unbounded quantifier that closes a group: `)` followed by +, *, or {n,}.
  const groupRepeat = /\)\s*(?:[+*]|\{\d+,\}?)/;

  // Walk each parenthesised group and inspect its body.
  // A group body that contains its own unbounded quantifier (`+`, `*`, `{n,}`)
  // AND is itself repeated is the nested-quantifier shape.
  const groupRe = /\(([^()]*)\)\s*([+*]|\{\d+,?\d*\}?)?/g;
  let m: RegExpExecArray | null;
  while ((m = groupRe.exec(pattern)) !== null) {
    const body = m[1] ?? '';
    const outerQuant = m[2] ?? '';
    // Only an *unbounded* outer quantifier can cause exponential blow-up.
    const outerUnbounded = outerQuant === '+' || outerQuant === '*' || /^\{\d+,\}?$/.test(outerQuant);
    if (!outerUnbounded) continue;

    // (a) nested unbounded quantifier inside the repeated group.
    if (/[+*]|\{\d+,/.test(body)) {
      return `nested-quantifier shape /(${body})${outerQuant}/`;
    }
    // (b) overlapping alternation inside the repeated group, e.g. (a|a)+,
    //     (a|ab)+. Any alternation under an unbounded repeat is treated as
    //     potentially overlapping and rejected conservatively.
    if (body.includes('|')) {
      return `overlapping-alternation shape /(${body})${outerQuant}/`;
    }
  }

  // Defensive catch-all for shapes the per-group scan above can miss because of
  // nested parentheses (the body regex is intentionally non-recursive).
  if (groupRepeat.test(pattern) && /\([^)]*[+*]/.test(pattern)) {
    return 'nested-quantifier shape (nested groups)';
  }
  return null;
}

/**
 * Execute `new RegExp(pattern).test(input)` with a synchronous, shape-based
 * ReDoS guard. No Worker threads are involved.
 *
 * @throws {Error} `CEL_TYPE_ERROR: REGEX_REJECTED` if the pattern has a
 *   catastrophic-backtracking shape.
 * @throws {Error} `CEL_TYPE_ERROR` if the pattern is syntactically invalid.
 */
function evalMatchesSafe(pattern: string, input: string): boolean {
  const reason = detectCatastrophicRegexShape(pattern);
  if (reason !== null) {
    throw new Error(
      `CEL_TYPE_ERROR: REGEX_REJECTED — regex /${pattern}/ has a ${reason} known to backtrack catastrophically`,
    );
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    throw new Error(`CEL_TYPE_ERROR: matches() invalid regex pattern: ${(e as Error).message}`);
  }
  return re.test(input);
}

export { detectCatastrophicRegexShape };

const logger = createLogger({ name: 'cel' });

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CompiledCel {
  readonly source: string;
  /** Cached AST — internal use. */
  readonly _ast: Expr;
}

export interface CelContext {
  readonly [k: string]: unknown;
}

export interface CelEvaluator {
  compile(expression: string): CompiledCel;
  evaluate(
    expression: string | CompiledCel,
    ctx: CelContext,
    phase: CelPhase,
  ): unknown;
  /**
   * Evaluate a YAML/DSL value with the ${expr} micro-syntax:
   *   - non-string values returned as-is
   *   - bare strings without ${} returned as-is
   *   - `${...}` (whole string) → CEL evaluation, preserving return type
   *   - mixed `prefix-${expr}-suffix` → CEL evaluation interpolated into the string
   *   - `$${literal}` → escapes to the literal `${literal}` (no evaluation)
   */
  evaluateDslValue(value: unknown, ctx: CelContext, phase: CelPhase): unknown;
  /** Return the current clock offset in milliseconds (per-instance). */
  getClockOffset(): number;
  /** Set the clock offset in milliseconds (positive moves $now() forward). Per-instance. */
  setClockOffset(ms: number): void;
  /**
   * Set (or clear) this evaluator's faker seed from a string. The seed and RNG
   * state are per-instance, so concurrent evaluators with different seeds do not
   * interfere. Passing `undefined` clears the seed (reverts $fake* to Math.random).
   */
  setFakerSeed(s: string | undefined): void;
}

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'string';      value: string }
  | { kind: 'number';      value: number }
  | { kind: 'bool';        value: boolean }
  | { kind: 'null' }
  | { kind: 'ident';       value: string }
  | { kind: 'op';          value: string }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'lbracket' }
  | { kind: 'rbracket' }
  | { kind: 'lbrace' }
  | { kind: 'rbrace' }
  | { kind: 'comma' }
  | { kind: 'dot' }
  | { kind: 'nullDot' }        // ?.
  | { kind: 'nullBracket' }    // ?[
  | { kind: 'colon' }
  | { kind: 'question' }
  | { kind: 'eof' };

// ---------------------------------------------------------------------------
// AST types
// ---------------------------------------------------------------------------

/** CEL receiver-style string/array/map methods: `expr.method(args)` */
const STRING_METHODS = new Set([
  'startsWith', 'endsWith', 'contains', 'size', 'matches', 'replace',
  'split', 'substring', 'indexOf', 'lastIndexOf', 'lowerAscii', 'upperAscii',
  'trim', 'trimStart', 'trimEnd', 'charAt',
]);
const LIST_METHODS = new Set([
  'size', 'contains', 'indexOf', 'lastIndexOf', 'sort', 'reverse',
  'join', 'flatten', 'distinct',
]);
const MAP_METHODS = new Set(['size', 'has', 'keys', 'values']);
const COMPREHENSION_METHODS = new Set(['all', 'exists', 'exists_one', 'filter', 'map']);

// All methods that should be parsed as method calls (not member access)
const RECEIVER_METHODS = new Set([
  ...STRING_METHODS,
  ...LIST_METHODS,
  ...MAP_METHODS,
  ...COMPREHENSION_METHODS,
]);

type Expr =
  | { kind: 'literal';        value: string | number | boolean | null }
  | { kind: 'ident';          name: string }
  | { kind: 'member';         obj: Expr; key: Expr }
  | { kind: 'nullSafeMember'; obj: Expr; key: Expr }
  | { kind: 'call';           fn: string; args: Expr[] }
  | { kind: 'method';         receiver: Expr; method: string; args: Expr[] }
  | { kind: 'nullSafeMethod'; receiver: Expr; method: string; args: Expr[] }
  | { kind: 'comprehension';  kind2: 'all' | 'exists' | 'exists_one' | 'filter' | 'map';
                               receiver: Expr; varName: string; body: Expr; nullSafe?: boolean }
  | { kind: 'unary';          op: string; operand: Expr }
  | { kind: 'binary';         op: string; left: Expr; right: Expr }
  | { kind: 'ternary';        cond: Expr; then: Expr; else: Expr }
  | { kind: 'array';          elements: Expr[] }
  | { kind: 'object';         entries: Array<{ key: Expr; value: Expr }> };

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < src.length) {
    // Skip whitespace
    if (/\s/.test(src[i]!)) { i++; continue; }

    // String literals (single or double quoted)
    if (src[i] === '"' || src[i] === "'") {
      const quote = src[i]!;
      i++;
      let s = '';
      const startPos = i - 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          i++;
          const esc = src[i];
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
          s += src[i];
        }
        i++;
      }
      if (i >= src.length) {
        throw new Error(`CEL_PARSE_ERROR: unclosed string literal starting at position ${startPos}`);
      }
      i++; // closing quote
      tokens.push({ kind: 'string', value: s });
      continue;
    }

    // Raw string literals r'...' or r"..."
    if (src[i] === 'r' && (src[i + 1] === '"' || src[i + 1] === "'")) {
      const quote = src[i + 1]!;
      i += 2;
      let s = '';
      const startPos = i - 2;
      while (i < src.length && src[i] !== quote) {
        s += src[i];
        i++;
      }
      if (i >= src.length) {
        throw new Error(`CEL_PARSE_ERROR: unclosed raw string literal starting at position ${startPos}`);
      }
      i++; // closing quote
      tokens.push({ kind: 'string', value: s });
      continue;
    }

    // Numbers
    if (/[0-9]/.test(src[i]!) || (src[i] === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let n = '';
      if (src[i] === '-') { n += '-'; i++; }
      while (i < src.length && /[0-9.]/.test(src[i]!)) { n += src[i]; i++; }
      tokens.push({ kind: 'number', value: parseFloat(n) });
      continue;
    }

    // Identifiers and keywords
    if (/[a-zA-Z_$]/.test(src[i]!)) {
      let id = '';
      while (i < src.length && /[a-zA-Z0-9_$]/.test(src[i]!)) { id += src[i]; i++; }
      if (id === 'true')  { tokens.push({ kind: 'bool', value: true }); continue; }
      if (id === 'false') { tokens.push({ kind: 'bool', value: false }); continue; }
      if (id === 'null')  { tokens.push({ kind: 'null' }); continue; }
      tokens.push({ kind: 'ident', value: id });
      continue;
    }

    // Two-character operators (check before single-char)
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
      tokens.push({ kind: 'op', value: two });
      i += 2;
      continue;
    }

    // '?.' null-safe member access
    if (two === '?.') {
      tokens.push({ kind: 'nullDot' });
      i += 2;
      continue;
    }

    // '?[' null-safe index access
    if (two === '?[') {
      tokens.push({ kind: 'nullBracket' });
      i += 2;
      continue;
    }

    // Single-character tokens
    const ch = src[i]!;
    switch (ch) {
      case '<': case '>': case '+': case '-': case '*': case '/': case '%': case '!':
        tokens.push({ kind: 'op', value: ch }); i++; continue;
      case '(': tokens.push({ kind: 'lparen' });   i++; continue;
      case ')': tokens.push({ kind: 'rparen' });   i++; continue;
      case '[': tokens.push({ kind: 'lbracket' }); i++; continue;
      case ']': tokens.push({ kind: 'rbracket' }); i++; continue;
      case '{': tokens.push({ kind: 'lbrace' });   i++; continue;
      case '}': tokens.push({ kind: 'rbrace' });   i++; continue;
      case ',': tokens.push({ kind: 'comma' });    i++; continue;
      case '.': tokens.push({ kind: 'dot' });      i++; continue;
      case ':': tokens.push({ kind: 'colon' });    i++; continue;
      case '?': tokens.push({ kind: 'question' }); i++; continue;
      default:
        throw new Error(`CEL_TOKENIZE: unexpected character '${ch}' at position ${i}`);
    }
  }

  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser — recursive descent
// ---------------------------------------------------------------------------

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  /* istanbul ignore next — tokenizer always appends eof; these ?? branches are defensive */
  private peek(): Token { return this.tokens[this.pos] ?? { kind: 'eof' }; }
  /* istanbul ignore next */
  private advance(): Token { return this.tokens[this.pos++] ?? { kind: 'eof' }; }

  private expect(kind: Token['kind']): Token {
    const t = this.advance();
    if (t.kind !== kind) throw new Error(`CEL_PARSE: expected ${kind}, got ${t.kind}`);
    return t;
  }

  private peekOp(op: string): boolean {
    const t = this.peek();
    return t.kind === 'op' && t.value === op;
  }

  parse(): Expr {
    const expr = this.parseTernary();
    if (this.peek().kind !== 'eof') {
      throw new Error(`CEL_PARSE: unexpected token '${this.peek().kind}' after expression`);
    }
    return expr;
  }

  private parseTernary(): Expr {
    const cond = this.parseOr();
    if (this.peek().kind === 'question') {
      this.advance();
      const then = this.parseTernary();
      this.expect('colon');
      const els = this.parseTernary();
      return { kind: 'ternary', cond, then, else: els };
    }
    return cond;
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.peek().kind === 'op' && (this.peek() as { kind: 'op'; value: string }).value === '||') {
      const op = (this.advance() as { kind: 'op'; value: string }).value;
      const right = this.parseAnd();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseEquality();
    while (this.peek().kind === 'op' && (this.peek() as { kind: 'op'; value: string }).value === '&&') {
      const op = (this.advance() as { kind: 'op'; value: string }).value;
      const right = this.parseEquality();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseEquality(): Expr {
    let left = this.parseIn();
    while (this.peek().kind === 'op') {
      const v = (this.peek() as { kind: 'op'; value: string }).value;
      if (v !== '==' && v !== '!=') break;
      const op = (this.advance() as { kind: 'op'; value: string }).value;
      const right = this.parseIn();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseIn(): Expr {
    let left = this.parseComparison();
    while (this.peek().kind === 'ident' && (this.peek() as { kind: 'ident'; value: string }).value === 'in') {
      this.advance();
      const right = this.parseComparison();
      left = { kind: 'binary', op: 'in', left, right };
    }
    return left;
  }

  private parseComparison(): Expr {
    let left = this.parseAddSub();
    while (this.peek().kind === 'op') {
      const v = (this.peek() as { kind: 'op'; value: string }).value;
      if (v !== '<' && v !== '<=' && v !== '>' && v !== '>=') break;
      const op = (this.advance() as { kind: 'op'; value: string }).value;
      const right = this.parseAddSub();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseAddSub(): Expr {
    let left = this.parseMulDiv();
    while (this.peek().kind === 'op') {
      const v = (this.peek() as { kind: 'op'; value: string }).value;
      if (v !== '+' && v !== '-') break;
      const op = (this.advance() as { kind: 'op'; value: string }).value;
      const right = this.parseMulDiv();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseMulDiv(): Expr {
    let left = this.parseUnary();
    while (this.peek().kind === 'op') {
      const v = (this.peek() as { kind: 'op'; value: string }).value;
      if (v !== '*' && v !== '/' && v !== '%') break;
      const op = (this.advance() as { kind: 'op'; value: string }).value;
      const right = this.parseUnary();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.peekOp('!')) {
      this.advance();
      const operand = this.parseUnary();
      return { kind: 'unary', op: '!', operand };
    }
    if (this.peekOp('-')) {
      this.advance();
      const operand = this.parseUnary();
      return { kind: 'unary', op: '-', operand };
    }
    return this.parsePostfix();
  }

  /**
   * Parse a method call argument list: ident, body
   * For comprehensions like lst.all(x, predicate)
   */
  private parseComprehensionArgs(): { varName: string; body: Expr } {
    const varTok = this.advance();
    if (varTok.kind !== 'ident') {
      throw new Error(`CEL_PARSE: comprehension expects identifier as first argument`);
    }
    this.expect('comma');
    const body = this.parseTernary();
    return { varName: varTok.value, body };
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();

    for (;;) {
      const tok = this.peek();

      if (tok.kind === 'dot' || tok.kind === 'nullDot') {
        const isNullSafe = tok.kind === 'nullDot';
        this.advance();
        const t = this.advance();
        if (t.kind !== 'ident') throw new Error(`CEL_PARSE: expected identifier after '${isNullSafe ? '?.' : '.'}'`);
        const methodName = t.value;

        // Check if this is a comprehension macro
        if (COMPREHENSION_METHODS.has(methodName) && this.peek().kind === 'lparen') {
          this.advance(); // consume '('
          const { varName, body } = this.parseComprehensionArgs();
          this.expect('rparen');
          const compKind = methodName as 'all' | 'exists' | 'exists_one' | 'filter' | 'map';
          expr = { kind: 'comprehension', kind2: compKind, receiver: expr, varName, body, nullSafe: isNullSafe };
        } else if (RECEIVER_METHODS.has(methodName) && this.peek().kind === 'lparen') {
          // Receiver method call
          this.advance(); // consume '('
          const args: Expr[] = [];
          while (this.peek().kind !== 'rparen') {
            if (args.length > 0) this.expect('comma');
            // Allow trailing comma before ')'
            if (this.peek().kind === 'rparen') break;
            args.push(this.parseTernary());
          }
          this.expect('rparen');
          if (isNullSafe) {
            expr = { kind: 'nullSafeMethod', receiver: expr, method: methodName, args };
          } else {
            expr = { kind: 'method', receiver: expr, method: methodName, args };
          }
        } else {
          // Member access
          const key: Expr = { kind: 'literal', value: methodName };
          if (isNullSafe) {
            expr = { kind: 'nullSafeMember', obj: expr, key };
          } else {
            expr = { kind: 'member', obj: expr, key };
          }
        }
      } else if (tok.kind === 'lbracket') {
        this.advance();
        const key = this.parseTernary();
        this.expect('rbracket');
        expr = { kind: 'member', obj: expr, key };
      } else if (tok.kind === 'nullBracket') {
        this.advance();
        const key = this.parseTernary();
        this.expect('rbracket');
        expr = { kind: 'nullSafeMember', obj: expr, key };
      } else {
        break;
      }
    }

    return expr;
  }

  private parsePrimary(): Expr {
    const t = this.peek();

    if (t.kind === 'string') { this.advance(); return { kind: 'literal', value: t.value }; }
    if (t.kind === 'number') { this.advance(); return { kind: 'literal', value: t.value }; }
    if (t.kind === 'bool')   { this.advance(); return { kind: 'literal', value: t.value }; }
    if (t.kind === 'null')   { this.advance(); return { kind: 'literal', value: null }; }

    if (t.kind === 'ident') {
      this.advance();
      // Function call?
      if (this.peek().kind === 'lparen') {
        this.advance();
        const args: Expr[] = [];
        while (this.peek().kind !== 'rparen') {
          if (args.length > 0) this.expect('comma');
          // Allow trailing comma
          if (this.peek().kind === 'rparen') break;
          args.push(this.parseTernary());
        }
        this.expect('rparen');
        return { kind: 'call', fn: t.value, args };
      }
      return { kind: 'ident', name: t.value };
    }

    if (t.kind === 'lparen') {
      this.advance();
      const expr = this.parseTernary();
      this.expect('rparen');
      return expr;
    }

    if (t.kind === 'lbracket') {
      this.advance();
      const elements: Expr[] = [];
      while (this.peek().kind !== 'rbracket') {
        if (elements.length > 0) this.expect('comma');
        // Allow trailing comma
        if (this.peek().kind === 'rbracket') break;
        elements.push(this.parseTernary());
      }
      this.expect('rbracket');
      return { kind: 'array', elements };
    }

    if (t.kind === 'lbrace') {
      this.advance();
      const entries: Array<{ key: Expr; value: Expr }> = [];
      while (this.peek().kind !== 'rbrace') {
        if (entries.length > 0) this.expect('comma');
        // Allow trailing comma
        if (this.peek().kind === 'rbrace') break;
        const key = this.parseTernary();
        this.expect('colon');
        const value = this.parseTernary();
        entries.push({ key, value });
      }
      this.expect('rbrace');
      return { kind: 'object', entries };
    }

    throw new Error(`CEL_PARSE: unexpected token kind '${t.kind}' in primary`);
  }
}

function parse(src: string): Expr {
  const tokens = tokenize(src);
  return new Parser(tokens).parse();
}

// ---------------------------------------------------------------------------
// Scope — chained variable bindings for comprehensions
// ---------------------------------------------------------------------------

type Scope = Map<string, unknown>;

function scopeLookup(scopes: Scope[], name: string): { found: true; value: unknown } | { found: false } {
  for (let i = scopes.length - 1; i >= 0; i--) {
    if (scopes[i]!.has(name)) {
      return { found: true, value: scopes[i]!.get(name) };
    }
  }
  return { found: false };
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function evalExpr(expr: Expr, ctx: CelContext, builtinCtx: BuiltinContext, scopes: Scope[] = []): unknown {
  switch (expr.kind) {
    case 'literal':
      return expr.value;

    case 'ident': {
      // Check scopes first (comprehension variables)
      const scopeResult = scopeLookup(scopes, expr.name);
      if (scopeResult.found) return scopeResult.value;
      if (expr.name in ctx) return ctx[expr.name];
      throw new Error(`CEL_EVAL: undefined identifier '${expr.name}'`);
    }

    case 'member': {
      const obj = evalExpr(expr.obj, ctx, builtinCtx, scopes);
      const key = evalExpr(expr.key, ctx, builtinCtx, scopes);
      if (typeof key === 'string' && isRecord(obj)) {
        return obj[key];
      }
      if (typeof key === 'number' && Array.isArray(obj)) {
        if (key < 0 || key >= obj.length) {
          throw new Error(`CEL_RUNTIME_ERROR: index out of range [${key}] with length ${obj.length}`);
        }
        return obj[key];
      }
      throw new Error(
        `CEL_EVAL: cannot access key ${JSON.stringify(key)} on ${typeof obj}`,
      );
    }

    case 'nullSafeMember': {
      const obj = evalExpr(expr.obj, ctx, builtinCtx, scopes);
      if (obj === null || obj === undefined) return null;
      const key = evalExpr(expr.key, ctx, builtinCtx, scopes);
      if (typeof key === 'string' && isRecord(obj)) {
        return obj[key] ?? null;
      }
      if (typeof key === 'number' && Array.isArray(obj)) {
        if (key < 0 || key >= obj.length) return null;
        return obj[key] ?? null;
      }
      return null;
    }

    case 'call': {
      // has(x.field) is a special macro: checks field presence without evaluation
      if (expr.fn === 'has' && expr.args.length === 1) {
        const arg = expr.args[0];
        if (!arg) throw new Error(`CEL_EVAL: has() requires exactly one argument`);
        if (arg.kind === 'member' && arg.key.kind === 'literal' && typeof arg.key.value === 'string') {
          const objVal = evalExpr(arg.obj, ctx, builtinCtx, scopes);
          if (isRecord(objVal)) return arg.key.value in objVal;
          if (Array.isArray(objVal)) return false;
          return false;
        }
        throw new Error(`CEL_EVAL: has() argument must be a field access expression like has(obj.field)`);
      }
      const args = expr.args.map(a => evalExpr(a, ctx, builtinCtx, scopes));
      return callBuiltin(expr.fn, args, builtinCtx);
    }

    case 'method': {
      return evalMethod(expr.receiver, expr.method, expr.args, ctx, builtinCtx, scopes, false);
    }

    case 'nullSafeMethod': {
      const receiver = evalExpr(expr.receiver, ctx, builtinCtx, scopes);
      if (receiver === null || receiver === undefined) return null;
      return evalMethod(expr.receiver, expr.method, expr.args, ctx, builtinCtx, scopes, false);
    }

    case 'comprehension': {
      return evalComprehension(expr, ctx, builtinCtx, scopes);
    }

    case 'unary': {
      const v = evalExpr(expr.operand, ctx, builtinCtx, scopes);
      if (expr.op === '!') return !v;
      if (expr.op === '-') {
        if (typeof v === 'number') return -v;
        throw new Error(`CEL_EVAL: unary '-' requires a number, got ${typeof v}`);
      }
      /* istanbul ignore next — parser only emits '!' and '-' unary ops */
      throw new Error(`CEL_EVAL: unknown unary operator '${expr.op}'`);
    }

    case 'binary': {
      const op = expr.op;

      // Short-circuit operators
      if (op === '&&') {
        const l = evalExpr(expr.left, ctx, builtinCtx, scopes);
        if (!l) return l;
        return evalExpr(expr.right, ctx, builtinCtx, scopes);
      }
      if (op === '||') {
        const l = evalExpr(expr.left, ctx, builtinCtx, scopes);
        if (l) return l;
        return evalExpr(expr.right, ctx, builtinCtx, scopes);
      }

      const left = evalExpr(expr.left, ctx, builtinCtx, scopes);
      const right = evalExpr(expr.right, ctx, builtinCtx, scopes);

      switch (op) {
        case '==': return deepEqual(left, right);
        case '!=': return !deepEqual(left, right);
        case '<':  return (left as number) < (right as number);
        case '<=': return (left as number) <= (right as number);
        case '>':  return (left as number) > (right as number);
        case '>=': return (left as number) >= (right as number);
        case '+': {
          if (typeof left === 'string' || typeof right === 'string') {
            return String(left) + String(right);
          }
          return (left as number) + (right as number);
        }
        case '-': return (left as number) - (right as number);
        case '*': return (left as number) * (right as number);
        case '/': {
          const divisor = right as number;
          if (divisor === 0) throw new Error(`CEL_RUNTIME_ERROR: divide by zero`);
          return (left as number) / divisor;
        }
        case '%': {
          const modulus = right as number;
          if (modulus === 0) throw new Error(`CEL_RUNTIME_ERROR: divide by zero`);
          return (left as number) % modulus;
        }
        case 'in': {
          if (Array.isArray(right)) return right.some(v => deepEqual(v, left));
          if (isRecord(right)) return (left as string) in right;
          throw new Error(`CEL_EVAL: 'in' requires an array or object on the right`);
        }
        /* istanbul ignore next — parser only emits known binary operators; defensive guard */
        default:
          throw new Error(`CEL_EVAL: unknown binary operator '${op}'`);
      }
    }

    case 'ternary': {
      const cond = evalExpr(expr.cond, ctx, builtinCtx, scopes);
      return cond ? evalExpr(expr.then, ctx, builtinCtx, scopes) : evalExpr(expr.else, ctx, builtinCtx, scopes);
    }

    case 'array': {
      return expr.elements.map(e => evalExpr(e, ctx, builtinCtx, scopes));
    }

    case 'object': {
      const obj: Record<string, unknown> = {};
      for (const entry of expr.entries) {
        const k = evalExpr(entry.key, ctx, builtinCtx, scopes);
        if (typeof k !== 'string') throw new Error(`CEL_EVAL: object key must be a string`);
        obj[k] = evalExpr(entry.value, ctx, builtinCtx, scopes);
      }
      return obj;
    }
  }
}

// ---------------------------------------------------------------------------
// Method dispatch
// ---------------------------------------------------------------------------

function evalMethod(
  receiverExpr: Expr,
  method: string,
  argExprs: Expr[],
  ctx: CelContext,
  builtinCtx: BuiltinContext,
  scopes: Scope[],
  _nullSafe: boolean,
): unknown {
  const receiver = evalExpr(receiverExpr, ctx, builtinCtx, scopes);
  const args = argExprs.map(a => evalExpr(a, ctx, builtinCtx, scopes));

  // String methods
  if (typeof receiver === 'string') {
    return evalStringMethod(receiver, method, args);
  }

  // List methods
  if (Array.isArray(receiver)) {
    return evalListMethod(receiver, method, args);
  }

  // Map methods
  if (isRecord(receiver)) {
    return evalMapMethod(receiver, method, args);
  }

  throw new Error(`CEL_EVAL: method '${method}' called on unsupported type ${typeof receiver}`);
}

function evalStringMethod(s: string, method: string, args: unknown[]): unknown {
  switch (method) {
    case 'startsWith': {
      if (typeof args[0] !== 'string') throw new Error(`CEL_TYPE_ERROR: startsWith requires a string argument`);
      return s.startsWith(args[0]);
    }
    case 'endsWith': {
      if (typeof args[0] !== 'string') throw new Error(`CEL_TYPE_ERROR: endsWith requires a string argument`);
      return s.endsWith(args[0]);
    }
    case 'contains': {
      if (typeof args[0] !== 'string') throw new Error(`CEL_TYPE_ERROR: contains requires a string argument`);
      return s.includes(args[0]);
    }
    case 'matches': {
      if (typeof args[0] !== 'string') throw new Error(`CEL_TYPE_ERROR: matches requires a string (regex) argument`);
      // Synchronous, shape-based ReDoS guard (no Worker threads). See evalMatchesSafe().
      return evalMatchesSafe(args[0], s);
    }
    case 'size':
      return s.length;
    case 'replace': {
      if (typeof args[0] !== 'string' || typeof args[1] !== 'string')
        throw new Error(`CEL_TYPE_ERROR: replace requires string arguments`);
      const [oldStr, newStr, maxN] = args;
      if (maxN !== undefined) {
        if (typeof maxN !== 'number') throw new Error(`CEL_TYPE_ERROR: replace n must be a number`);
        let result = s;
        let count = 0;
        const n = Math.trunc(maxN as number);
        while (count < n && result.includes(oldStr as string)) {
          result = result.replace(oldStr as string, newStr as string);
          count++;
        }
        return result;
      }
      return s.split(oldStr as string).join(newStr as string);
    }
    case 'split': {
      if (typeof args[0] !== 'string') throw new Error(`CEL_TYPE_ERROR: split requires a string separator`);
      return s.split(args[0]);
    }
    case 'substring': {
      if (typeof args[0] !== 'number') throw new Error(`CEL_TYPE_ERROR: substring requires a number start`);
      const start = Math.trunc(args[0]);
      if (args.length >= 2) {
        if (typeof args[1] !== 'number') throw new Error(`CEL_TYPE_ERROR: substring end must be a number`);
        return s.substring(start, Math.trunc(args[1] as number));
      }
      return s.substring(start);
    }
    case 'indexOf': {
      if (typeof args[0] !== 'string') throw new Error(`CEL_TYPE_ERROR: indexOf requires a string argument`);
      return s.indexOf(args[0]);
    }
    case 'lastIndexOf': {
      if (typeof args[0] !== 'string') throw new Error(`CEL_TYPE_ERROR: lastIndexOf requires a string argument`);
      return s.lastIndexOf(args[0]);
    }
    case 'lowerAscii':
      return s.toLowerCase();
    case 'upperAscii':
      return s.toUpperCase();
    case 'trim':
      return s.trim();
    case 'trimStart':
      return s.trimStart();
    case 'trimEnd':
      return s.trimEnd();
    case 'charAt': {
      if (typeof args[0] !== 'number') throw new Error(`CEL_TYPE_ERROR: charAt requires a number argument`);
      const idx = Math.trunc(args[0]);
      if (idx < 0 || idx >= s.length) throw new Error(`CEL_RUNTIME_ERROR: charAt index out of range`);
      return s.charAt(idx);
    }
    default:
      throw new Error(`CEL_EVAL: unknown string method '${method}'`);
  }
}

function evalListMethod(lst: unknown[], method: string, args: unknown[]): unknown {
  switch (method) {
    case 'size':
      return lst.length;
    case 'contains':
      return lst.some(v => deepEqual(v, args[0]));
    case 'indexOf': {
      const idx = lst.findIndex(v => deepEqual(v, args[0]));
      return idx;
    }
    case 'lastIndexOf': {
      let last = -1;
      for (let i = 0; i < lst.length; i++) {
        if (deepEqual(lst[i], args[0])) last = i;
      }
      return last;
    }
    case 'sort': {
      const copy = [...lst];
      copy.sort(naturalCompare);
      return copy;
    }
    case 'reverse': {
      return [...lst].reverse();
    }
    case 'join': {
      const sep = args[0] ?? '';
      if (typeof sep !== 'string') throw new Error(`CEL_TYPE_ERROR: join separator must be a string`);
      return lst.map(v => String(v)).join(sep);
    }
    case 'flatten': {
      const result: unknown[] = [];
      for (const item of lst) {
        if (Array.isArray(item)) {
          result.push(...item);
        } else {
          result.push(item);
        }
      }
      return result;
    }
    case 'distinct': {
      const seen: unknown[] = [];
      for (const item of lst) {
        if (!seen.some(s => deepEqual(s, item))) {
          seen.push(item);
        }
      }
      return seen;
    }
    default:
      throw new Error(`CEL_EVAL: unknown list method '${method}'`);
  }
}

function evalMapMethod(m: Record<string, unknown>, method: string, args: unknown[]): unknown {
  switch (method) {
    case 'size':
      return Object.keys(m).length;
    case 'has': {
      const key = args[0];
      if (typeof key !== 'string') throw new Error(`CEL_TYPE_ERROR: map.has() requires a string key`);
      return key in m;
    }
    case 'keys':
      return Object.keys(m);
    case 'values':
      return Object.values(m);
    default:
      throw new Error(`CEL_EVAL: unknown map method '${method}'`);
  }
}

// ---------------------------------------------------------------------------
// Comprehension evaluation
// ---------------------------------------------------------------------------

type ComprehensionKind = 'all' | 'exists' | 'exists_one' | 'filter' | 'map';

function evalComprehension(
  expr: { kind: 'comprehension'; kind2: ComprehensionKind; receiver: Expr; varName: string; body: Expr; nullSafe?: boolean },
  ctx: CelContext,
  builtinCtx: BuiltinContext,
  scopes: Scope[],
): unknown {
  const collection = evalExpr(expr.receiver, ctx, builtinCtx, scopes);

  // REQ-49 / null-safe comprehension fix: if the receiver is null/undefined and the
  // macro was invoked with ?. (nullSafe flag), short-circuit to null instead of throwing.
  if ((collection === null || collection === undefined) && expr.nullSafe) {
    return null;
  }

  let items: unknown[];
  if (Array.isArray(collection)) {
    items = collection;
  } else if (isRecord(collection)) {
    // For maps, iterate over keys
    items = Object.keys(collection);
  } else {
    throw new Error(`CEL_EVAL: comprehension receiver must be a list or map, got ${typeof collection}`);
  }

  switch (expr.kind2) {
    case 'all': {
      for (const item of items) {
        const scope = new Map([[expr.varName, item]]);
        const result = evalExpr(expr.body, ctx, builtinCtx, [...scopes, scope]);
        if (!result) return false;
      }
      return true;
    }
    case 'exists': {
      for (const item of items) {
        const scope = new Map([[expr.varName, item]]);
        const result = evalExpr(expr.body, ctx, builtinCtx, [...scopes, scope]);
        if (result) return true;
      }
      return false;
    }
    case 'exists_one': {
      let count = 0;
      for (const item of items) {
        const scope = new Map([[expr.varName, item]]);
        const result = evalExpr(expr.body, ctx, builtinCtx, [...scopes, scope]);
        if (result) count++;
        if (count > 1) return false;
      }
      return count === 1;
    }
    case 'filter': {
      const filtered: unknown[] = [];
      for (const item of items) {
        const scope = new Map([[expr.varName, item]]);
        const result = evalExpr(expr.body, ctx, builtinCtx, [...scopes, scope]);
        if (result) filtered.push(item);
      }
      return filtered;
    }
    case 'map': {
      const mapped: unknown[] = [];
      for (const item of items) {
        const scope = new Map([[expr.varName, item]]);
        const result = evalExpr(expr.body, ctx, builtinCtx, [...scopes, scope]);
        mapped.push(result);
      }
      return mapped;
    }
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Parse the DSL value micro-syntax once at call time. Returns a plan to evaluate.
 * - non-string: pass-through
 * - "$${X}" anywhere: literal-escape sequence — leaves "${X}" in the output
 * - whole-string "${expr}": evaluate expr, preserve return type
 * - mixed "prefix-${expr}-suffix": evaluate expr, coerce to string, interpolate
 */
type DslPlan =
  | { kind: 'literal'; value: unknown }
  | { kind: 'whole'; expr: string }
  | { kind: 'interp'; parts: Array<{ kind: 'lit' | 'expr'; text: string }> };

function planDslValue(value: unknown): DslPlan {
  if (typeof value !== 'string') return { kind: 'literal', value };
  const s = value;
  // Backward-compat: bare strings without ${} are evaluated as CEL.
  if (!s.includes('${') && !s.includes('$${')) return { kind: 'whole', expr: s };

  // Tokenize: ${...} → expr; $${...} → literal "${...}"
  const parts: Array<{ kind: 'lit' | 'expr'; text: string }> = [];
  let i = 0;
  let buf = '';
  while (i < s.length) {
    if (s[i] === '$' && s[i + 1] === '$' && s[i + 2] === '{') {
      const close = findClosingBrace(s, i + 3);
      if (close === -1) { buf += s[i]; i++; continue; }
      buf += '${' + s.slice(i + 3, close) + '}';
      i = close + 1;
      continue;
    }
    if (s[i] === '$' && s[i + 1] === '{') {
      if (buf) { parts.push({ kind: 'lit', text: buf }); buf = ''; }
      const close = findClosingBrace(s, i + 2);
      if (close === -1) { buf += s[i]; i++; continue; }
      parts.push({ kind: 'expr', text: s.slice(i + 2, close) });
      i = close + 1;
      continue;
    }
    buf += s[i]; i++;
  }
  if (buf) parts.push({ kind: 'lit', text: buf });

  if (parts.length === 1 && parts[0]!.kind === 'expr') {
    return { kind: 'whole', expr: parts[0]!.text };
  }
  if (parts.every(p => p.kind === 'lit')) {
    return { kind: 'literal', value: parts.map(p => p.text).join('') };
  }
  return { kind: 'interp', parts };
}

function findClosingBrace(s: string, start: number): number {
  let depth = 1;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

export function createCelEvaluator(): CelEvaluator {
  // Per-instance clock offset (ms) and faker RNG. Instance state — NOT module
  // globals — so concurrent booted systems and parallel requests do not
  // share/clobber them.
  let clockOffsetMs = 0;
  const fakeRng: FakeRng = createFakeRng();
  const evaluator: CelEvaluator = {
    compile(expression: string): CompiledCel {
      let ast: Expr;
      try {
        ast = parse(expression);
      } catch (err) {
        logger.debug(
          { src: expression.slice(0, 120) },
          // eslint-disable-next-line @typescript-eslint/no-base-to-string
          `CEL compile error: ${err instanceof Error ? err.message : /* istanbul ignore next */ String(err)}`,
        );
        throw err;
      }
      return { source: expression, _ast: ast };
    },

    evaluate(
      expression: string | CompiledCel,
      ctx: CelContext,
      phase: CelPhase,
    ): unknown {
      const compiled: CompiledCel =
        typeof expression === 'string' ? this.compile(expression) : expression;

      const builtinCtx: BuiltinContext = {
        phase,
        now: () => new Date(Date.now() + clockOffsetMs).toISOString(),
        fake: fakeRng,
      };

      try {
        return evalExpr(compiled._ast, ctx, builtinCtx, []);
      } catch (err) {
        logger.debug(
          {
            src: compiled.source.slice(0, 120),
            ctxKeys: Object.keys(ctx),
          },
          // eslint-disable-next-line @typescript-eslint/no-base-to-string
          `CEL evaluate error: ${err instanceof Error ? err.message : /* istanbul ignore next */ String(err)}`,
        );
        throw err;
      }
    },

    evaluateDslValue(value: unknown, ctx: CelContext, phase: CelPhase): unknown {
      const plan = planDslValue(value);
      switch (plan.kind) {
        case 'literal':
          return plan.value;
        case 'whole':
          return evaluator.evaluate(plan.expr, ctx, phase);
        case 'interp': {
          let out = '';
          for (const p of plan.parts) {
            if (p.kind === 'lit') { out += p.text; continue; }
            const v = evaluator.evaluate(p.text, ctx, phase);
            out += v === null || v === undefined ? '' : String(v);
          }
          return out;
        }
      }
    },

    getClockOffset(): number { return clockOffsetMs; },
    setClockOffset(ms: number): void { clockOffsetMs = Number.isFinite(ms) ? ms : 0; },
    setFakerSeed(s: string | undefined): void { fakeRng.seedString(s); },
  };
  return evaluator;
}
