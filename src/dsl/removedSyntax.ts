// Single source of truth for the reducer-mutation vocabulary policy. Both DSL
// validators — the in-memory pipeline (schema.ts:validateBoundaryConfig, used
// by compileDsl) and the on-disk pipeline (configSchema.ts:validateBoundaryModule,
// used by loadPotemkinConfig) — delegate here, so there is exactly one place
// that decides which reducer keys are legal.
//
// Reducers express state mutation exclusively via `patches:`. The legacy
// `assign:` / `append:` / `assignAll:` keys are removed and rejected at boot.

import { BootError } from '../errors.js';

/** Reducer keys removed in favour of `patches:`. */
export const REMOVED_REDUCER_KEYS: readonly string[] = ['assign', 'append', 'assignAll'];

/**
 * Throw BOOT_ERR_REMOVED_SYNTAX if `reducer` carries any removed mutation key.
 * `ctx` is a human-readable locator (e.g. "reducers[2]" or a file path) used in
 * the error message.
 */
export function assertNoRemovedReducerKeys(reducer: Record<string, unknown>, ctx: string): void {
  for (const key of REMOVED_REDUCER_KEYS) {
    if (reducer[key] !== undefined) {
      throw new BootError(
        'BOOT_ERR_REMOVED_SYNTAX',
        `${ctx}.${key}: reducer field "${key}" was removed — use "patches:" with the RFC 6902 + Potemkin extensions vocabulary`,
        { field: `${ctx}.${key}`, removed: key, replacement: 'patches' },
      );
    }
  }
}
