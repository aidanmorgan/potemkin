import { CelPhase } from './phases.js';
import { nextUuidv7 } from '../ids/uuidv7.js';

export interface BuiltinContext {
  readonly phase: CelPhase;
  readonly now?: () => string;
  readonly uuid?: () => string;
}

/** Functions banned in the Reducer phase (non-deterministic side-effects). */
const REDUCER_BANNED = new Set(['$uuidv7', '$now', 'now', 'timestamp', '$fake', '$fakeSeed', '$fakeFromFormat']);

// ── Seeded PRNG (Mulberry32) shared by all $fake* builtins ────────────────────
let fakeRngSeed = 0;
let fakeRngState = 0;
let fakeRngSeeded = false;
function nextRandom(): number {
  if (!fakeRngSeeded) return Math.random();
  fakeRngState = (fakeRngState + 0x6D2B79F5) | 0;
  let t = fakeRngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function setFakeSeed(seed: number): void {
  fakeRngSeed = seed >>> 0;
  fakeRngState = fakeRngSeed;
  fakeRngSeeded = true;
}
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(nextRandom() * arr.length)]!;
}
function randomDigits(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(nextRandom() * 10).toString();
  return s;
}
function randomAlphanumeric(n: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(nextRandom() * alphabet.length)]!;
  return s;
}

const FAKE_DATA: Record<string, Record<string, () => string>> = {
  person: {
    firstName: () => pick(['Alex', 'Jordan', 'Sam', 'Taylor', 'Casey', 'Morgan', 'Riley', 'Quinn', 'Avery', 'Drew']),
    lastName: () => pick(['Smith', 'Jones', 'Brown', 'Taylor', 'Wilson', 'Davies', 'Evans', 'Robinson', 'Walker', 'Wright']),
    fullName: () => `${FAKE_DATA['person']!['firstName']!()} ${FAKE_DATA['person']!['lastName']!()}`,
  },
  internet: {
    email: () => `${randomAlphanumeric(8).toLowerCase()}@${pick(['example.com', 'test.org', 'fake.net'])}`,
    url: () => `https://${randomAlphanumeric(6).toLowerCase()}.example.com/${randomAlphanumeric(4).toLowerCase()}`,
    domainName: () => `${randomAlphanumeric(6).toLowerCase()}.example.com`,
  },
  phone: {
    number: () => `+61 ${randomDigits(1)} ${randomDigits(4)} ${randomDigits(4)}`,
  },
  company: {
    name: () => `${pick(['Apex', 'BlueSky', 'Cornerstone', 'Delta', 'Echo', 'Foxtrot'])} ${pick(['Solutions', 'Systems', 'Holdings', 'Group', 'Industries'])}`,
  },
  address: {
    city: () => pick(['Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide', 'Hobart']),
    streetAddress: () => `${Math.floor(nextRandom() * 999) + 1} ${pick(['George', 'King', 'Queen', 'High', 'Main'])} St`,
  },
};

function fakeUuid(): string {
  // Random UUIDv4 — deterministic when seeded.
  const hex = (n: number): string => {
    let s = '';
    for (let i = 0; i < n; i++) s += Math.floor(nextRandom() * 16).toString(16);
    return s;
  };
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(['8', '9', 'a', 'b'])}${hex(3)}-${hex(12)}`;
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

// The clock offset is per-CelEvaluator-instance state (see createCelEvaluator),
// NOT a module global, so concurrent systems/requests stay isolated. The $now
// builtin receives the offset-aware clock via BuiltinContext.now.

// Optional faker seed — when set, $fake* builtins (if any) use a deterministic RNG.
let fakerSeed: number | undefined = undefined;
export function setFakerSeedFromString(s: string | undefined): void {
  if (s === undefined) { fakerSeed = undefined; return; }
  // Simple FNV-like hash to a 32-bit int seed.
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  fakerSeed = h >>> 0;
}
export function getFakerSeed(): number | undefined { return fakerSeed; }

/**
 * Registry of built-in CEL functions available to expression evaluators.
 * Keys: `$uuidv7`, `$now`, `$concat`, plus extended set.
 */
export const BUILTINS: Record<string, (...args: unknown[]) => unknown> = {
  // ── Original builtins ──────────────────────────────────────────────────
  $uuidv7: (..._args: unknown[]): unknown => nextUuidv7(),

  // Offset-aware time is supplied via BuiltinContext.now (callBuiltin routes $now
  // through it); this bare fallback is real time when no context clock is given.
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

  // ── Faker ────────────────────────────────────────────────────────────────
  $fake: (...args: unknown[]): unknown => {
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
    return fn();
  },

  $fakeSeed: (...args: unknown[]): unknown => {
    const [n] = args;
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new Error(`CEL_TYPE_ERROR: $fakeSeed() requires a number`);
    }
    setFakeSeed(n);
    return n;
  },

  $fakeFromFormat: (...args: unknown[]): unknown => {
    const [fmt] = args;
    if (typeof fmt !== 'string') {
      throw new Error(`CEL_TYPE_ERROR: $fakeFromFormat() requires a string argument`);
    }
    switch (fmt) {
      case 'email':     return FAKE_DATA['internet']!['email']!();
      case 'uuid':      return fakeUuid();
      case 'date':      return new Date().toISOString().slice(0, 10);
      case 'date-time': return new Date().toISOString();
      case 'uri':
      case 'url':       return FAKE_DATA['internet']!['url']!();
      case 'hostname':  return FAKE_DATA['internet']!['domainName']!();
      case 'ipv4':      return `${Math.floor(nextRandom() * 256)}.${Math.floor(nextRandom() * 256)}.${Math.floor(nextRandom() * 256)}.${Math.floor(nextRandom() * 256)}`;
      default:          return randomAlphanumeric(10);
    }
  },
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
