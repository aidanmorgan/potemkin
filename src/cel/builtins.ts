import { CelPhase } from './phases.js';

export interface BuiltinContext {
  phase: CelPhase;
  now?: () => string;
  uuid?: () => string;
}

/**
 * Registry of built-in CEL functions available to expression evaluators.
 * Keys: `$uuidv7`, `$now`, `$concat`
 */
export const BUILTINS: Record<string, (...args: unknown[]) => unknown> = {
  $uuidv7: (..._args: unknown[]): unknown => {
    throw new Error('NotImplemented: cel/builtins.$uuidv7');
  },
  $now: (..._args: unknown[]): unknown => {
    throw new Error('NotImplemented: cel/builtins.$now');
  },
  $concat: (..._args: unknown[]): unknown => {
    throw new Error('NotImplemented: cel/builtins.$concat');
  },
};

/**
 * Invoke a built-in by name, enforcing phase restrictions.
 * - `$uuidv7` and `$now` are banned in the `Reducer` phase.
 * @throws {Error} if the builtin is unknown or banned in the current phase.
 */
export function callBuiltin(
  name: string,
  args: unknown[],
  ctx: BuiltinContext,
): unknown {
  throw new Error('NotImplemented: cel/builtins.callBuiltin');
}
