/**
 * CEL evaluator — Path B: hand-rolled recursive-descent parser + evaluator.
 *
 * Rationale: `cel-js` is not in dependencies and adding an unknown third-party
 * CEL implementation risks subtle semantic differences. A focused ~350-line
 * implementation that exactly covers the DSL subset is safer and simpler.
 *
 * Supported subset:
 *   - Literals: string, number, boolean (true/false), null
 *   - Identifiers from context (state, command, event, payload, …)
 *   - Property access: a.b  and  a["b"]  and  a[0]
 *   - Function calls: $uuidv7(), $now(), $concat(…)
 *   - Operators: ==, !=, <, <=, >, >=, &&, ||, !, +, -, *, /, %, ternary ?:
 *   - String concatenation via +
 *   - Membership: "x" in ["x","y"]  or  "x" in {"x": 1}
 */

import { CelPhase } from './phases.js';
import { callBuiltin, type BuiltinContext } from './builtins.js';
import { createLogger } from '../observability/logger.js';
import { getTracer, withSpan } from '../observability/tracing.js';

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
  | { kind: 'string';  value: string }
  | { kind: 'number';  value: number }
  | { kind: 'bool';    value: boolean }
  | { kind: 'null' }
  | { kind: 'ident';   value: string }
  | { kind: 'op';      value: string }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'lbracket' }
  | { kind: 'rbracket' }
  | { kind: 'lbrace' }
  | { kind: 'rbrace' }
  | { kind: 'comma' }
  | { kind: 'dot' }
  | { kind: 'colon' }
  | { kind: 'question' }
  | { kind: 'eof' };

// ---------------------------------------------------------------------------
// AST types
// ---------------------------------------------------------------------------

type Expr =
  | { kind: 'literal';   value: string | number | boolean | null }
  | { kind: 'ident';     name: string }
  | { kind: 'member';    obj: Expr; key: Expr }        // a.b or a["b"] or a[0]
  | { kind: 'call';      fn: string; args: Expr[] }    // $func(…)
  | { kind: 'unary';     op: string; operand: Expr }
  | { kind: 'binary';    op: string; left: Expr; right: Expr }
  | { kind: 'ternary';   cond: Expr; then: Expr; else: Expr }
  | { kind: 'array';     elements: Expr[] }
  | { kind: 'object';    entries: Array<{ key: Expr; value: Expr }> };

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < src.length) {
    // Skip whitespace
    if (/\s/.test(src[i]!)) { i++; continue; }

    // String literals
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

    // Two-character operators
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
      tokens.push({ kind: 'op', value: two });
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
    // `in` is an identifier token
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
      // Could be a unary minus; check next token is not a number literal (already handled in tokenizer)
      this.advance();
      const operand = this.parseUnary();
      return { kind: 'unary', op: '-', operand };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();

    for (;;) {
      if (this.peek().kind === 'dot') {
        this.advance();
        const t = this.advance();
        if (t.kind !== 'ident') throw new Error(`CEL_PARSE: expected identifier after '.'`);
        const key: Expr = { kind: 'literal', value: t.value };
        expr = { kind: 'member', obj: expr, key };
      } else if (this.peek().kind === 'lbracket') {
        this.advance();
        const key = this.parseTernary();
        this.expect('rbracket');
        expr = { kind: 'member', obj: expr, key };
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
// Evaluator
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function evalExpr(expr: Expr, ctx: CelContext, builtinCtx: BuiltinContext): unknown {
  switch (expr.kind) {
    case 'literal':
      return expr.value;

    case 'ident': {
      if (expr.name in ctx) return ctx[expr.name];
      throw new Error(`CEL_EVAL: undefined identifier '${expr.name}'`);
    }

    case 'member': {
      const obj = evalExpr(expr.obj, ctx, builtinCtx);
      const key = evalExpr(expr.key, ctx, builtinCtx);
      if (typeof key === 'string' && isRecord(obj)) {
        return obj[key];
      }
      if (typeof key === 'number' && Array.isArray(obj)) {
        return obj[key];
      }
      throw new Error(
        `CEL_EVAL: cannot access key ${JSON.stringify(key)} on ${typeof obj}`,
      );
    }

    case 'call': {
      const args = expr.args.map(a => evalExpr(a, ctx, builtinCtx));
      return callBuiltin(expr.fn, args, builtinCtx);
    }

    case 'unary': {
      const v = evalExpr(expr.operand, ctx, builtinCtx);
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
        const l = evalExpr(expr.left, ctx, builtinCtx);
        if (!l) return l;
        return evalExpr(expr.right, ctx, builtinCtx);
      }
      if (op === '||') {
        const l = evalExpr(expr.left, ctx, builtinCtx);
        if (l) return l;
        return evalExpr(expr.right, ctx, builtinCtx);
      }

      const left = evalExpr(expr.left, ctx, builtinCtx);
      const right = evalExpr(expr.right, ctx, builtinCtx);

      switch (op) {
        case '==': return left === right;
        case '!=': return left !== right;
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
        case '/': return (left as number) / (right as number);
        case '%': return (left as number) % (right as number);
        case 'in': {
          if (Array.isArray(right)) return right.includes(left);
          if (isRecord(right)) return (left as string) in right;
          throw new Error(`CEL_EVAL: 'in' requires an array or object on the right`);
        }
        /* istanbul ignore next — parser only emits known binary operators; defensive guard */
        default:
          throw new Error(`CEL_EVAL: unknown binary operator '${op}'`);
      }
    }

    case 'ternary': {
      const cond = evalExpr(expr.cond, ctx, builtinCtx);
      return cond ? evalExpr(expr.then, ctx, builtinCtx) : evalExpr(expr.else, ctx, builtinCtx);
    }

    case 'array': {
      return expr.elements.map(e => evalExpr(e, ctx, builtinCtx));
    }

    case 'object': {
      const obj: Record<string, unknown> = {};
      for (const entry of expr.entries) {
        const k = evalExpr(entry.key, ctx, builtinCtx);
        if (typeof k !== 'string') throw new Error(`CEL_EVAL: object key must be a string`);
        obj[k] = evalExpr(entry.value, ctx, builtinCtx);
      }
      return obj;
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
      // TODO: Consider wrapping in withSpan(getTracer('cel'), 'cel.evaluate', …)
      // if perf profiling shows tracing overhead is acceptable. Skipped for now
      // to avoid async overhead on a synchronous hot path.
      void withSpan; // imported — available if needed
      void getTracer;

      const compiled: CompiledCel =
        typeof expression === 'string' ? this.compile(expression) : expression;

      const builtinCtx: BuiltinContext = { phase };

      try {
        return evalExpr(compiled._ast, ctx, builtinCtx);
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
