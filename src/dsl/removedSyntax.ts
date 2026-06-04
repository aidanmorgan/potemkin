// Single source of truth for the removed-syntax policies.
//
// Reducers express state mutation exclusively via `patches:`. The legacy
// `assign:` / `append:` / `assignAll:` keys are removed and rejected at boot —
// the reducer-key check (assertNoRemovedReducerKeys) is applied by the
// in-memory pipeline (schema.ts); the on-disk path inherits it via schema.ts.
//
// Inline scripts (`scripts: [{ name, code }]`) are removed. Scripts are now
// authored as @Script(id) class files discovered via typescript.scan and
// referenced with the `ts:<id>` sentinel. The inline-scripts check
// (assertNoInlineScripts) is applied by the in-memory boundary validator
// (schema.ts:validateBoundaryConfig) — the only pipeline that ever accepted the
// inline `scripts:` form.

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

const INLINE_SCRIPTS_MIGRATION_MESSAGE =
  'inline `scripts:` is removed — author scripts as a @Script(id) class in a scanned .ts file ' +
  '(see typescript.scan) and reference them with ts:<id>';

/**
 * Throw BOOT_ERR_REMOVED_SYNTAX if the boundary raw object contains a `scripts:`
 * key, indicating the caller is still using the inline `scripts: [{ name, code }]`
 * form. `ctx` is a human-readable locator (e.g. "root" or the boundary name).
 */
export function assertNoInlineScripts(raw: Record<string, unknown>, ctx: string): void {
  if (raw['scripts'] !== undefined) {
    throw new BootError(
      'BOOT_ERR_REMOVED_SYNTAX',
      `${ctx}.scripts: ${INLINE_SCRIPTS_MIGRATION_MESSAGE}`,
      { field: `${ctx}.scripts`, removed: 'scripts', replacement: '@Script(id)' },
    );
  }
}
