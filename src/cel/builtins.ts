import { CelPhase } from './phases.js';
import { nextUuidv7 } from '../ids/uuidv7.js';

export interface BuiltinContext {
  readonly phase: CelPhase;
  readonly now?: () => string;
  readonly uuid?: () => string;
  /**
   * Per-evaluator-instance faker RNG. When supplied, callBuiltin routes the
   * `$fake*` builtins through it so the seed and RNG state are isolated per
   * CelEvaluator instance (no module-level globals that race across concurrent
   * requests or leak across jest worker test files). When absent, $fake* fall
   * back to an unseeded RNG (Math.random).
   */
  readonly fake?: FakeRng;
}

// ── Seeded PRNG (Mulberry32) — one instance per CelEvaluator ──────────────────
//
// The seed and RNG state live inside a FakeRng instance, not in module-level
// variables, so concurrent evaluators are isolated.

/** Per-instance seeded PRNG for the $fake* builtins. */
export interface FakeRng {
  /** Next pseudo-random float in [0, 1). Unseeded → Math.random(). */
  next(): number;
  /** Seed from a 32-bit-ish number (used by $fakeSeed). */
  seedNumber(seed: number): void;
  /**
   * Seed from a string (used by the gateway transparency seed). `undefined`
   * clears the seed, reverting to Math.random().
   */
  seedString(s: string | undefined): void;
}

/** Create a fresh, independent faker RNG with its own seed/state. */
export function createFakeRng(): FakeRng {
  let state = 0;
  let seeded = false;
  return {
    next(): number {
      if (!seeded) return Math.random();
      state = (state + 0x6d2b79f5) | 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    seedNumber(seed: number): void {
      state = seed >>> 0;
      seeded = true;
    },
    seedString(s: string | undefined): void {
      if (s === undefined) { seeded = false; state = 0; return; }
      // Simple FNV-like hash to a 32-bit int seed.
      let h = 2166136261;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      state = h >>> 0;
      seeded = true;
    },
  };
}

function pick<T>(rng: FakeRng, arr: readonly T[]): T {
  return arr[Math.floor(rng.next() * arr.length)]!;
}
function randomDigits(rng: FakeRng, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(rng.next() * 10).toString();
  return s;
}
function randomAlphanumeric(rng: FakeRng, n: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(rng.next() * alphabet.length)]!;
  return s;
}

const FAKE_DATA: Record<string, Record<string, (rng: FakeRng) => string>> = {
  person: {
    firstName: (rng) => pick(rng, ['Alex', 'Jordan', 'Sam', 'Taylor', 'Casey', 'Morgan', 'Riley', 'Quinn', 'Avery', 'Drew']),
    lastName: (rng) => pick(rng, ['Smith', 'Jones', 'Brown', 'Taylor', 'Wilson', 'Davies', 'Evans', 'Robinson', 'Walker', 'Wright']),
    fullName: (rng) => `${FAKE_DATA['person']!['firstName']!(rng)} ${FAKE_DATA['person']!['lastName']!(rng)}`,
  },
  internet: {
    email: (rng) => `${randomAlphanumeric(rng, 8).toLowerCase()}@${pick(rng, ['example.com', 'test.org', 'fake.net'])}`,
    url: (rng) => `https://${randomAlphanumeric(rng, 6).toLowerCase()}.example.com/${randomAlphanumeric(rng, 4).toLowerCase()}`,
    domainName: (rng) => `${randomAlphanumeric(rng, 6).toLowerCase()}.example.com`,
  },
  phone: {
    number: (rng) => `+61 ${randomDigits(rng, 1)} ${randomDigits(rng, 4)} ${randomDigits(rng, 4)}`,
  },
  company: {
    name: (rng) => `${pick(rng, ['Apex', 'BlueSky', 'Cornerstone', 'Delta', 'Echo', 'Foxtrot'])} ${pick(rng, ['Solutions', 'Systems', 'Holdings', 'Group', 'Industries'])}`,
  },
  address: {
    city: (rng) => pick(rng, ['Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide', 'Hobart']),
    streetAddress: (rng) => `${Math.floor(rng.next() * 999) + 1} ${pick(rng, ['George', 'King', 'Queen', 'High', 'Main'])} St`,
  },
};

function fakeUuid(rng: FakeRng): string {
  // UUIDv4 — deterministic when the rng is seeded.
  const hex = (n: number): string => {
    let s = '';
    for (let i = 0; i < n; i++) s += Math.floor(rng.next() * 16).toString(16);
    return s;
  };
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(rng, ['8', '9', 'a', 'b'])}${hex(3)}-${hex(12)}`;
}

// ── $fake* implementations ────────────────────────────────────────────────────

function fake(rng: FakeRng, ...args: unknown[]): unknown {
  const [spec] = args;
  if (typeof spec !== 'string') {
    throw new Error(`CEL_TYPE_ERROR: $fake() requires a string argument like 'person.firstName'`);
  }
  const dot = spec.indexOf('.');
  if (dot === -1) {
    throw new Error(`CEL_TYPE_ERROR: $fake() argument must be 'module.method'`);
  }
  const module = spec.slice(0, dot);
  const method = spec.slice(dot + 1);
  const mod = FAKE_DATA[module];
  if (!mod) throw new Error(`CEL_RUNTIME_ERROR: $fake() unknown faker category '${module}'`);
  const fn = mod[method];
  if (!fn) throw new Error(`CEL_RUNTIME_ERROR: $fake() unknown faker category '${module}.${method}'`);
  return fn(rng);
}

function fakeSeed(rng: FakeRng, ...args: unknown[]): unknown {
  const [n] = args;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new Error(`CEL_TYPE_ERROR: $fakeSeed() requires a number`);
  }
  rng.seedNumber(n);
  return n;
}

// Bounded window for deterministic faker dates: 2000-01-01 to 2050-01-01.
const FAKE_DATE_EPOCH_START = Date.UTC(2000, 0, 1);
const FAKE_DATE_EPOCH_END = Date.UTC(2050, 0, 1);

function fakeDate(rng: FakeRng): Date {
  const span = FAKE_DATE_EPOCH_END - FAKE_DATE_EPOCH_START;
  const offset = Math.floor(rng.next() * span);
  return new Date(FAKE_DATE_EPOCH_START + offset);
}

function fakeFromFormat(rng: FakeRng, ...args: unknown[]): unknown {
  const [fmt] = args;
  if (typeof fmt !== 'string') {
    throw new Error(`CEL_TYPE_ERROR: $fakeFromFormat() requires a string argument`);
  }
  switch (fmt) {
    case 'email':     return FAKE_DATA['internet']!['email']!(rng);
    case 'uuid':      return fakeUuid(rng);
    case 'date':      return fakeDate(rng).toISOString().slice(0, 10);
    case 'date-time': return fakeDate(rng).toISOString();
    case 'uri':
    case 'url':       return FAKE_DATA['internet']!['url']!(rng);
    case 'hostname':  return FAKE_DATA['internet']!['domainName']!(rng);
    case 'ipv4':      return `${Math.floor(rng.next() * 256)}.${Math.floor(rng.next() * 256)}.${Math.floor(rng.next() * 256)}.${Math.floor(rng.next() * 256)}`;
    default:          return randomAlphanumeric(rng, 10);
  }
}

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
    // Reject degenerate inputs like "P" or "PT" where no component was captured.
    if (!d && !h && !m && !sec) {
      throw new Error(`CEL_RUNTIME_ERROR: invalid duration string: ${JSON.stringify(s)}`);
    }
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
 * $now and $fake* receive per-instance state via BuiltinContext; all others
 * are stateless.
 */
export const BUILTINS: Record<string, (...args: unknown[]) => unknown> = {
  $uuidv7: (..._args: unknown[]): unknown => nextUuidv7(),

  // Fallback: real time. callBuiltin routes $now through BuiltinContext.now
  // (offset-aware clock) when a context is provided.
  $now: (..._args: unknown[]): unknown => new Date().toISOString(),

  $concat: (...args: unknown[]): unknown =>
    args.map(a => {
      if (a === null || a === undefined) return '';
      if (typeof a === 'object') return JSON.stringify(a);
      return String(a);
    }).join(''),

  // ── Type conversions ──────────────────────────────────────────────────────
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
    if (typeof x === 'object') return JSON.stringify(x);
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
    if (flat.length === 0) throw new Error(`CEL_RUNTIME_ERROR: min() of empty list`);
    if (!flat.every(a => typeof a === 'number'))
      throw new Error(`CEL_TYPE_ERROR: min() requires number arguments`);
    return Math.min(...(flat as number[]));
  },

  max: (...args: unknown[]): unknown => {
    if (args.length === 0) throw new Error(`CEL_RUNTIME_ERROR: max() requires at least one argument`);
    let flat: unknown[] = args;
    if (args.length === 1 && Array.isArray(args[0])) flat = args[0];
    if (flat.length === 0) throw new Error(`CEL_RUNTIME_ERROR: max() of empty list`);
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

  // length() — alias of size() for strings/lists/maps. Lets computed-field
  // formulas read naturally (e.g. length(lineItems)).
  length: (...args: unknown[]): unknown => {
    const [x] = args;
    if (typeof x === 'string') return x.length;
    if (Array.isArray(x)) return x.length;
    if (x !== null && typeof x === 'object') return Object.keys(x as Record<string, unknown>).length;
    throw new Error(`CEL_TYPE_ERROR: length() requires string, list, or map`);
  },

  // sum() — total of a numeric list (sum(list) or spread). null/undefined
  // elements are treated as 0.
  sum: (...args: unknown[]): unknown => {
    let flat: unknown[];
    if (args.length === 1 && Array.isArray(args[0])) flat = args[0];
    else flat = args;
    let total = 0;
    for (const v of flat) {
      if (v === null || v === undefined) continue;
      if (typeof v !== 'number') {
        throw new Error(`CEL_TYPE_ERROR: sum() requires a list of numbers`);
      }
      total += v;
    }
    return total;
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

// ── Faker builtin names ───────────────────────────────────────────────────────
// $fake* are not entries in BUILTINS because they require a per-instance FakeRng
// (supplied via BuiltinContext.fake). Listing the names here lets callBuiltin
// recognise them and enforce the reducer-phase ban.
const FAKE_BUILTINS = new Set(['$fake', '$fakeSeed', '$fakeFromFormat']);

/** Functions banned in the Reducer phase (non-deterministic side-effects). */
const REDUCER_BANNED = new Set(['$uuidv7', '$now', 'now', 'timestamp', '$fake', '$fakeSeed', '$fakeFromFormat']);

// Export deepEqual for use in evaluator
export { deepEqual, naturalCompare };

// Shared unseeded RNG for the fallback path when no BuiltinContext.fake is
// supplied. Never seeded — every call is Math.random().
const UNSEEDED_FAKE_RNG: FakeRng = {
  next: () => Math.random(),
  /* istanbul ignore next — unseeded fallback is never seeded; seeding flows through a per-instance rng */
  seedNumber: () => { /* no-op */ },
  /* istanbul ignore next */
  seedString: () => { /* no-op */ },
};

/**
 * Invoke a built-in by name, enforcing phase restrictions.
 * @throws {Error} if the builtin is unknown or banned in the current phase.
 */
export function callBuiltin(
  name: string,
  args: unknown[],
  ctx: BuiltinContext,
): unknown {
  const isFake = FAKE_BUILTINS.has(name);
  if (!isFake && !(name in BUILTINS)) {
    throw new Error(`CEL_UNKNOWN_BUILTIN: unknown function '${name}'`);
  }

  if (ctx.phase === CelPhase.Reducer && REDUCER_BANNED.has(name)) {
    throw new Error(
      `CEL_PHASE_BANNED: '${name}' is not allowed in phase '${ctx.phase}' because it is non-deterministic`,
    );
  }

  // Dispatch with context-provided overrides for clock/RNG-sensitive builtins.
  switch (name) {
    case '$uuidv7':
      return ctx.uuid ? ctx.uuid() : nextUuidv7();
    case '$now':
      return ctx.now ? ctx.now() : new Date().toISOString();
    case 'now':
      return ctx.now ? ctx.now() : new Date().toISOString();
    case '$fake':
      return fake(ctx.fake ?? UNSEEDED_FAKE_RNG, ...args);
    case '$fakeSeed':
      return fakeSeed(ctx.fake ?? UNSEEDED_FAKE_RNG, ...args);
    case '$fakeFromFormat':
      return fakeFromFormat(ctx.fake ?? UNSEEDED_FAKE_RNG, ...args);
    default:
      return BUILTINS[name]!(...args);
  }
}
