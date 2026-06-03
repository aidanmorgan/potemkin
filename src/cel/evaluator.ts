/**
 * CEL evaluator.
 *
 * Parsing is performed by the formal-grammar-driven, table-driven LALR(1)
 * parser in `src/cel/grammar/` (grammar: docs/grammar/cel.grammar.md). This
 * module consumes the typed AST it produces and evaluates it. The DSL value
 * `${expr}` template syntax is parsed by the template grammar in
 * `src/cel/grammar/template.ts`. No regex or hand-rolled structural parsing of
 * expressions or interpolation lives here.
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

import type { CelPhase } from './phases.js';
import {
  callBuiltin, deepEqual, naturalCompare, createFakeRng,
  type BuiltinContext, type FakeRng,
} from './builtins.js';
import { createLogger } from '../observability/logger.js';
import { parse } from './grammar/parser.js';
import type { Expr } from './grammar/ast.js';
import { parseTemplate } from './grammar/template.js';

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

/**
 * Per-request, immutable CEL context controls (X-Potemkin-Clock-Offset /
 * X-Potemkin-Seed). Produced once per inbound request by the gateway /
 * forwarding handler via {@link CelEvaluator.withRequestContext} and carried
 * for the request's lifetime — NEVER mutated onto the shared evaluator. This is
 * what makes concurrent requests isolated: a request's clock offset and faker
 * seed live in the per-request sub-evaluator, so a second concurrent request
 * cannot read or clobber the first's offset/seed.
 */
export interface CelRequestContext {
  /** Additional clock offset (ms) layered on top of the server-wide admin clock. */
  readonly clockOffsetMs?: number;
  /** Faker seed string; seeds the per-request RNG so $fake* output is deterministic. */
  readonly seed?: string;
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
  /**
   * Effective clock offset in milliseconds (positive moves $now() forward).
   * On the root evaluator this is the server-wide admin clock; on a per-request
   * sub-evaluator it is the admin clock PLUS this request's offset.
   */
  getClockOffset(): number;
  /**
   * Set the server-wide admin clock offset in milliseconds. Used only by the
   * admin clock endpoints (/_admin/clock/*) and reset — NOT by per-request
   * control headers, which flow through {@link withRequestContext} instead.
   */
  setClockOffset(ms: number): void;
  /**
   * Derive a lightweight per-request sub-evaluator that layers this request's
   * clock offset and faker seed on top of the shared evaluator WITHOUT mutating
   * it. The sub-evaluator shares the parent root's admin clock and host/root
   * registry (via parentRoot), so concurrent requests each get their own
   * offset/seed with no cross-request leak. Returns `this` when the request
   * context carries neither control.
   */
  withRequestContext(reqCtx: CelRequestContext): CelEvaluator;
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
        const val = obj[key];
        // Normalise absent keys to CEL null — never leak JS undefined.
        return val === undefined ? null : val;
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
      // has(x.field) is a special macro — checks field presence without evaluation
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
      return evalMethod(expr.receiver, expr.method, expr.args, ctx, builtinCtx, scopes, false, { value: receiver });
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
      /* istanbul ignore next — parser only emits '!' and '-' */
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
            const toStr = (v: unknown): string => {
              if (v === null || v === undefined) return 'null';
              if (typeof v === 'object') return JSON.stringify(v);
              return String(v);
            };
            return toStr(left) + toStr(right);
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
        /* istanbul ignore next — parser only emits known binary operators */
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
  preEvaluatedReceiver?: { value: unknown },
): unknown {
  const receiver = preEvaluatedReceiver !== undefined
    ? preEvaluatedReceiver.value
    : evalExpr(receiverExpr, ctx, builtinCtx, scopes);
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

  // Null-safe comprehension: if the receiver is null/undefined and the macro was
  // invoked with ?. (nullSafe flag), short-circuit to null instead of throwing.
  if ((collection === null || collection === undefined) && expr.nullSafe) {
    return null;
  }

  let items: unknown[];
  if (Array.isArray(collection)) {
    items = collection;
  } else if (isRecord(collection)) {
    items = Object.keys(collection); // for maps, iterate over keys
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
 * Build a CelEvaluator whose effective clock offset is supplied by `offsetOf()`
 * (re-read on every $now/timestamp call) and whose $fake* RNG is `rng`. Both the
 * root evaluator and per-request sub-evaluators share this implementation:
 *   - root:        offsetOf reads the mutable admin clock; rng is unseeded.
 *   - per-request: offsetOf adds the request offset to the admin clock; rng is
 *                  seeded from the request seed (or the parent's unseeded rng).
 *
 * `setAdminOffset` mutates the server-wide admin clock and is wired only on the
 * root evaluator (admin endpoints + reset). `parentRoot` is the root evaluator
 * a sub-evaluator was derived from, so chained `withRequestContext` calls always
 * re-layer onto the same admin clock rather than onto another request's offset.
 */
function buildEvaluator(args: {
  offsetOf: () => number;
  rng: FakeRng;
  setAdminOffset: (ms: number) => void;
  parentRoot: CelEvaluator | null;
}): CelEvaluator {
  const { offsetOf, rng, setAdminOffset } = args;

  const compile = (expression: string): CompiledCel => {
    let ast: Expr;
    try {
      ast = parse(expression);
    } catch (err) {
      logger.debug(
        { src: expression.slice(0, 120) },
         
        `CEL compile error: ${err instanceof Error ? err.message : /* istanbul ignore next */ String(err)}`,
      );
      throw err;
    }
    return { source: expression, _ast: ast };
  };

  const evaluator: CelEvaluator = {
    compile,

    evaluate(
      expression: string | CompiledCel,
      ctx: CelContext,
      phase: CelPhase,
    ): unknown {
      const compiled: CompiledCel =
        typeof expression === 'string' ? compile(expression) : expression;

      const builtinCtx: BuiltinContext = {
        phase,
        now: () => new Date(Date.now() + offsetOf()).toISOString(),
        fake: rng,
      };

      try {
        return evalExpr(compiled._ast, ctx, builtinCtx, []);
      } catch (err) {
        logger.debug(
          {
            src: compiled.source.slice(0, 120),
            ctxKeys: Object.keys(ctx),
          },
           
          `CEL evaluate error: ${err instanceof Error ? err.message : /* istanbul ignore next */ String(err)}`,
        );
        throw err;
      }
    },

    evaluateDslValue(value: unknown, ctx: CelContext, phase: CelPhase): unknown {
      const plan = parseTemplate(value);
      switch (plan.kind) {
        case 'literal':
          return plan.value;
        case 'whole':
          return evaluator.evaluate(plan.expr, ctx, phase);
        case 'interp': {
          let out = '';
          for (const p of plan.parts) {
            if (p.kind === 'text') { out += p.text; continue; }
            const v = evaluator.evaluate(p.src, ctx, phase);
            out += v === null || v === undefined ? '' : String(v);
          }
          return out;
        }
      }
    },

    getClockOffset(): number { return offsetOf(); },
    setClockOffset(ms: number): void { setAdminOffset(ms); },

    withRequestContext(reqCtx: CelRequestContext): CelEvaluator {
      // Always layer onto the originating root's admin clock so chaining
      // withRequestContext never compounds one request's offset onto another's.
      const root = args.parentRoot ?? evaluator;
      const reqOffset = Number.isFinite(reqCtx.clockOffsetMs ?? NaN) ? (reqCtx.clockOffsetMs as number) : 0;
      const hasOffset = reqCtx.clockOffsetMs !== undefined && reqOffset !== 0;
      const hasSeed = reqCtx.seed !== undefined;
      if (!hasOffset && !hasSeed) return root;

      // Fresh, independently-seeded RNG when a seed is supplied; otherwise
      // fall through to the parent's unseeded rng so $fake* output is identical.
      let reqRng: FakeRng = rng;
      if (hasSeed) {
        reqRng = createFakeRng();
        reqRng.seedString(reqCtx.seed);
      }
      return buildEvaluator({
        offsetOf: () => root.getClockOffset() + reqOffset,
        rng: reqRng,
        // Delegate to root so the server-wide clock is never forked per request.
        setAdminOffset: (ms: number) => root.setClockOffset(ms),
        parentRoot: root,
      });
    },
  };
  return evaluator;
}

export function createCelEvaluator(): CelEvaluator {
  // adminClockOffsetMs and fakeRng are instance state, not module globals, so
  // concurrent booted systems stay isolated. Per-request overrides (clock
  // offset, faker seed) live in a per-request sub-evaluator; see withRequestContext.
  let adminClockOffsetMs = 0;
  const fakeRng: FakeRng = createFakeRng();
  return buildEvaluator({
    offsetOf: () => adminClockOffsetMs,
    rng: fakeRng,
    setAdminOffset: (ms: number) => { adminClockOffsetMs = Number.isFinite(ms) ? ms : 0; },
    parentRoot: null,
  });
}
