import { CelPhase } from './phases.js';
import { nextUuidv7 } from '../ids/uuidv7.js';

export interface BuiltinContext {
  phase: CelPhase;
  now?: () => string;
  uuid?: () => string;
}

/** Functions banned in the Reducer phase (non-deterministic side-effects). */
const REDUCER_BANNED = new Set(['$uuidv7', '$now']);

/**
 * Registry of built-in CEL functions available to expression evaluators.
 * Keys: `$uuidv7`, `$now`, `$concat`
 *
 * Note: these bare implementations do NOT enforce phase restrictions — use
 * `callBuiltin` which carries the BuiltinContext for phase checking.
 */
export const BUILTINS: Record<string, (...args: unknown[]) => unknown> = {
  /** Returns a new UUIDv7. Banned in CelPhase.Reducer. */
  $uuidv7: (..._args: unknown[]): unknown => {
    return nextUuidv7();
  },

  /** Returns the current time as an ISO-8601 string. Banned in CelPhase.Reducer. */
  $now: (..._args: unknown[]): unknown => {
    return new Date().toISOString();
  },

  /** Concatenates all arguments coerced to strings. Allowed in all phases. */
  $concat: (...args: unknown[]): unknown => {
    return args.map(a => (a === null || a === undefined ? '' : String(a))).join('');
  },
};

/**
 * Invoke a built-in by name, enforcing phase restrictions.
 * - `$uuidv7` and `$now` are banned in the `Reducer` phase.
 * - `$uuidv7` uses `ctx.uuid()` if provided, else `nextUuidv7()`.
 * - `$now` uses `ctx.now()` if provided, else `new Date().toISOString()`.
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
    case '$concat':
      return BUILTINS['$concat']!(...args);
    default:
      return BUILTINS[name]!(...args);
  }
}
