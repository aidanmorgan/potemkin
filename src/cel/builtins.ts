import { CelPhase } from './phases.js';
import { nextUuidv7 } from '../ids/uuidv7.js';

export interface BuiltinContext {
  readonly phase: CelPhase;
  readonly now?: () => string;
  readonly uuid?: () => string;
}

/** Functions banned in the Reducer phase (non-deterministic side-effects). */
const REDUCER_BANNED = new Set(['$uuidv7', '$now', 'now', 'timestamp']);

// ---------------------------------------------------------------------------
// Deep equality helper
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aRec = a as Record<string, unknown>;
    const bRec = b as Record<string, unknown>;
    const aKeys = Object.keys(aRec);
    const bKeys = Object.keys(bRec);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(k => deepEqual(aRec[k], bRec[k]));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Natural comparison for sort
// ---------------------------------------------------------------------------

function naturalCompare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Duration parser
// ---------------------------------------------------------------------------

function parseDuration(s: string): number {
  // ISO 8601 duration like P1D, PT1H, P1DT2H3M4S
  const isoMatch = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s);
  if (isoMatch) {
    const [, d, h, m, sec] = isoMatch;
    return (
      (d ? parseInt(d, 10) * 86400000 : 0) +
      (h ? parseInt(h, 10) * 3600000 : 0) +
      (m ? parseInt(m, 10) * 60000 : 0) +
      (sec ? parseFloat(sec) * 1000 : 0)
    );
  }
  // Simple shorthand: 30s, 1m, 2h, 3d
  const simpleMatch = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(s);
  if (simpleMatch) {
    const [, num, unit] = simpleMatch;
    const val = parseFloat(num!);
    switch (unit) {
      case 's': return val * 1000;
      case 'm': return val * 60000;
      case 'h': return val * 3600000;
      case 'd': return val * 86400000;
    }
  }
  throw new Error(`CEL_RUNTIME_ERROR: invalid duration string: ${JSON.stringify(s)}`);
}

// ---------------------------------------------------------------------------
// Builtin implementations
// ---------------------------------------------------------------------------

/**
 * Registry of built-in CEL functions available to expression evaluators.
 * Keys: `$uuidv7`, `$now`, `$concat`, plus extended set.
 */
export const BUILTINS: Record<string, (...args: unknown[]) => unknown> = {
  // ── Original builtins ──────────────────────────────────────────────────
  $uuidv7: (..._args: unknown[]): unknown => nextUuidv7(),

  $now: (..._args: unknown[]): unknown => new Date().toISOString(),

  $concat: (...args: unknown[]): unknown =>
    args.map(a => (a === null || a === undefined ? '' : String(a))).join(''),

  // ── Type conversions ────────────────────────────────────────────────────
  int: (...args: unknown[]): unknown => {
    const [x] = args;
    if (typeof x === 'number') return Math.trunc(x);
    if (typeof x === 'string') {
      const n = Number(x);
      if (isNaN(n)) throw new Error(`CEL_TYPE_ERROR: int() cannot convert ${JSON.stringify(x)}`);
      return Math.trunc(n);
    }
    if (typeof x === 'boolean') return x ? 1 : 0;
    throw new Error(`CEL_TYPE_ERROR: int() cannot convert ${typeof x}`);
  },

  double: (...args: unknown[]): unknown => {
    const [x] = args;
    if (typeof x === 'number') return x;
    if (typeof x === 'string') {
      const n = Number(x);
      if (isNaN(n)) throw new Error(`CEL_TYPE_ERROR: double() cannot convert ${JSON.stringify(x)}`);
      return n;
    }
    if (typeof x === 'boolean') return x ? 1 : 0;
    throw new Error(`CEL_TYPE_ERROR: double() cannot convert ${typeof x}`);
  },

  string: (...args: unknown[]): unknown => {
    const [x] = args;
    if (x === null || x === undefined) return 'null';
    return String(x);
  },

  bool: (...args: unknown[]): unknown => {
    const [x] = args;
    if (typeof x === 'boolean') return x;
    if (typeof x === 'string') {
      if (x === 'true') return true;
      if (x === 'false') return false;
      throw new Error(`CEL_TYPE_ERROR: bool() cannot convert ${JSON.stringify(x)}`);
    }
    if (typeof x === 'number') return x !== 0;
    throw new Error(`CEL_TYPE_ERROR: bool() cannot convert ${typeof x}`);
  },

  bytes: (...args: unknown[]): unknown => {
    const [x] = args;
    if (typeof x !== 'string') throw new Error(`CEL_TYPE_ERROR: bytes() requires a string`);
    const result: number[] = [];
    for (let i = 0; i < x.length; i++) {
      result.push(x.charCodeAt(i) & 0xff);
    }
    return result;
  },

  // ── Math ────────────────────────────────────────────────────────────────
  abs: (...args: unknown[]): unknown => {
    const [x] = args;
    if (typeof x !== 'number') throw new Error(`CEL_TYPE_ERROR: abs() requires a number`);
    return Math.abs(x);
  },

  min: (...args: unknown[]): unknown => {
    if (args.length === 0) throw new Error(`CEL_RUNTIME_ERROR: min() requires at least one argument`);
    let flat: unknown[] = args;
    if (args.length === 1 && Array.isArray(args[0])) flat = args[0];
    if (!flat.every(a => typeof a === 'number'))
      throw new Error(`CEL_TYPE_ERROR: min() requires number arguments`);
    return Math.min(...(flat as number[]));
  },

  max: (...args: unknown[]): unknown => {
    if (args.length === 0) throw new Error(`CEL_RUNTIME_ERROR: max() requires at least one argument`);
    let flat: unknown[] = args;
    if (args.length === 1 && Array.isArray(args[0])) flat = args[0];
    if (!flat.every(a => typeof a === 'number'))
      throw new Error(`CEL_TYPE_ERROR: max() requires number arguments`);
    return Math.max(...(flat as number[]));
  },

  floor: (...args: unknown[]): unknown => {
    const [x] = args;
    if (typeof x !== 'number') throw new Error(`CEL_TYPE_ERROR: floor() requires a number`);
    return Math.floor(x);
  },

  ceil: (...args: unknown[]): unknown => {
    const [x] = args;
    if (typeof x !== 'number') throw new Error(`CEL_TYPE_ERROR: ceil() requires a number`);
    return Math.ceil(x);
  },

  round: (...args: unknown[]): unknown => {
    const [x] = args;
    if (typeof x !== 'number') throw new Error(`CEL_TYPE_ERROR: round() requires a number`);
    return Math.round(x);
  },

  pow: (...args: unknown[]): unknown => {
    const [a, b] = args;
    if (typeof a !== 'number' || typeof b !== 'number')
      throw new Error(`CEL_TYPE_ERROR: pow() requires number arguments`);
    return Math.pow(a, b);
  },

  sqrt: (...args: unknown[]): unknown => {
    const [x] = args;
    if (typeof x !== 'number') throw new Error(`CEL_TYPE_ERROR: sqrt() requires a number`);
    if (x < 0) throw new Error(`CEL_RUNTIME_ERROR: sqrt() of negative number`);
    return Math.sqrt(x);
  },

  // ── Collections ─────────────────────────────────────────────────────────
  size: (...args: unknown[]): unknown => {
    const [x] = args;
    if (typeof x === 'string') return x.length;
    if (Array.isArray(x)) return x.length;
    if (x !== null && typeof x === 'object') return Object.keys(x as Record<string, unknown>).length;
    throw new Error(`CEL_TYPE_ERROR: size() requires string, list, or map`);
  },

  keys: (...args: unknown[]): unknown => {
    const [x] = args;
    if (x === null || typeof x !== 'object' || Array.isArray(x))
      throw new Error(`CEL_TYPE_ERROR: keys() requires a map`);
    return Object.keys(x as Record<string, unknown>);
  },

  values: (...args: unknown[]): unknown => {
    const [x] = args;
    if (x === null || typeof x !== 'object' || Array.isArray(x))
      throw new Error(`CEL_TYPE_ERROR: values() requires a map`);
    return Object.values(x as Record<string, unknown>);
  },

  range: (...args: unknown[]): unknown => {
    if (args.length === 1) {
      const [end] = args;
      if (typeof end !== 'number') throw new Error(`CEL_TYPE_ERROR: range() requires number arguments`);
      const n = Math.trunc(end);
      const result: number[] = [];
      for (let i = 0; i < n; i++) result.push(i);
      return result;
    }
    if (args.length === 2) {
      const [start, end] = args;
      if (typeof start !== 'number' || typeof end !== 'number')
        throw new Error(`CEL_TYPE_ERROR: range() requires number arguments`);
      const s = Math.trunc(start);
      const e = Math.trunc(end);
      const result: number[] = [];
      for (let i = s; i < e; i++) result.push(i);
      return result;
    }
    throw new Error(`CEL_RUNTIME_ERROR: range() requires 1 or 2 arguments`);
  },

  // ── Type introspection ──────────────────────────────────────────────────
  type: (...args: unknown[]): unknown => {
    const [x] = args;
    if (x === null || x === undefined) return 'null';
    if (typeof x === 'boolean') return 'bool';
    if (typeof x === 'string') return 'string';
    if (typeof x === 'number') return Number.isInteger(x) ? 'int' : 'double';
    if (Array.isArray(x)) {
      // check if bytes (array of numbers 0-255)
      if (x.length > 0 && x.every(v => typeof v === 'number' && v >= 0 && v <= 255 && Number.isInteger(v)))
        return 'bytes';
      return 'list';
    }
    if (typeof x === 'object') return 'map';
    return 'unknown';
  },

  // ── Null helpers ────────────────────────────────────────────────────────
  coalesce: (...args: unknown[]): unknown => {
    for (const a of args) {
      if (a !== null && a !== undefined) return a;
    }
    return null;
  },

  default: (...args: unknown[]): unknown => {
    const [a, fallback] = args;
    return (a !== null && a !== undefined) ? a : (fallback ?? null);
  },

  // ── Date/timestamp ──────────────────────────────────────────────────────
  timestamp: (...args: unknown[]): unknown => {
    const [s] = args;
    if (typeof s !== 'string') throw new Error(`CEL_TYPE_ERROR: timestamp() requires a string`);
    // Validate it's a parseable date
    const d = new Date(s);
    if (isNaN(d.getTime())) throw new Error(`CEL_RUNTIME_ERROR: timestamp() invalid date: ${JSON.stringify(s)}`);
    return d.toISOString();
  },

  duration: (...args: unknown[]): unknown => {
    const [s] = args;
    if (typeof s !== 'string') throw new Error(`CEL_TYPE_ERROR: duration() requires a string`);
    return parseDuration(s);
  },

  now: (..._args: unknown[]): unknown => new Date().toISOString(),
};

// Export deepEqual for use in evaluator
export { deepEqual, naturalCompare };

/**
 * Invoke a built-in by name, enforcing phase restrictions.
 * @throws {Error} if the builtin is unknown or banned in the current phase.
 */
export function callBuiltin(
  name: string,
  args: unknown[],
  ctx: BuiltinContext,
): unknown {
  if (!(name in BUILTINS)) {
    throw new Error(`CEL_UNKNOWN_BUILTIN: unknown function '${name}'`);
  }

  if (ctx.phase === CelPhase.Reducer && REDUCER_BANNED.has(name)) {
    throw new Error(
      `CEL_PHASE_BANNED: '${name}' is not allowed in phase '${ctx.phase}' because it is non-deterministic`,
    );
  }

  // Dispatch with context-provided overrides for $uuidv7 and $now
  switch (name) {
    case '$uuidv7':
      return ctx.uuid ? ctx.uuid() : nextUuidv7();
    case '$now':
      return ctx.now ? ctx.now() : new Date().toISOString();
    case 'now':
      return ctx.now ? ctx.now() : new Date().toISOString();
    default:
      return BUILTINS[name]!(...args);
  }
}
