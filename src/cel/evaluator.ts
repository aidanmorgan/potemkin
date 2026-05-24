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
import { callBuiltin, deepEqual, naturalCompare, type BuiltinContext } from './builtins.js';
import { createLogger } from '../observability/logger.js';

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
                               receiver: Expr; varName: string; body: Expr }
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
          expr = { kind: 'comprehension', kind2: compKind, receiver: expr, varName, body };
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
      return new RegExp(args[0]).test(s);
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
  expr: { kind: 'comprehension'; kind2: ComprehensionKind; receiver: Expr; varName: string; body: Expr },
  ctx: CelContext,
  builtinCtx: BuiltinContext,
  scopes: Scope[],
): unknown {
  const collection = evalExpr(expr.receiver, ctx, builtinCtx, scopes);

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

export function createCelEvaluator(): CelEvaluator {
  return {
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

      const builtinCtx: BuiltinContext = { phase };

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
  };
}
