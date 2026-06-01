// Shared reducer patch application. Both the live projection (projection.ts)
// and the time-travel replay (timeTravel.ts) reduce events by running a
// reducer's `patches:` list through the single canonical applier in
// src/dsl/patches.ts.

import type { JsonObject, JsonValue } from '../types.js';
import type { ReducerPatchOp } from '../dsl/types.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import { CelPhase } from '../cel/phases.js';
import { applyPatches, type Patch, type JournalEntry } from '../dsl/patches.js';

/**
 * Convert a DSL reducer patch into a canonical src/dsl/patches.ts `Patch`,
 * evaluating its `value` as CEL against the supplied context. String values
 * are evaluated in the Reducer phase (so `event.payload.x` / `state.y` /
 * `${...}` references resolve); a value that is not valid CEL falls back to its
 * literal string. Non-string values (numbers, booleans, objects, arrays) pass
 * through unchanged. The boundary validator rejects ill-formed CEL at boot, so
 * the fallback only ever sees genuine string literals at runtime.
 */
export function resolveReducerPatch(
  patch: ReducerPatchOp,
  cel: CelEvaluator,
  celCtx: Record<string, unknown>,
): Patch {
  // Reducer patch values use the ${expr} template form: CEL references must
  // be wrapped in ${...}; bare text is a literal. evaluateDslValue evaluates a
  // whole-string ${expr} with type preserved, interpolates mixed text, and
  // returns bare strings as-is. Non-string values pass through unchanged.
  const evaluate = (raw: unknown): JsonValue =>
    cel.evaluateDslValue(raw, celCtx, CelPhase.Reducer) as JsonValue;

  switch (patch.op) {
    case 'remove':
      return { op: 'remove', path: patch.path };
    case 'move':
    case 'copy':
      return { op: patch.op, from: patch.from ?? patch.path, path: patch.path };
    case 'increment':
      return { op: 'increment', path: patch.path, by: patch.by ?? 0 };
    case 'merge':
      return {
        op: 'merge',
        path: patch.path,
        value: evaluate(patch.value) as Record<string, JsonValue>,
        ...(patch.deep !== undefined ? { deep: patch.deep } : {}),
      };
    case 'upsert':
      return {
        op: 'upsert',
        path: patch.path,
        key: patch.key ?? 'id',
        value: evaluate(patch.value) as Record<string, JsonValue>,
      };
    case 'add':
    case 'replace':
    case 'append':
    case 'prepend':
      return { op: patch.op, path: patch.path, value: evaluate(patch.value) };
  }
}

/** Replace all keys of `target` with those of `source` in-place (preserves `target` identity). */
function replaceInPlace(target: JsonObject, source: JsonObject): void {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  for (const [key, val] of Object.entries(source)) {
    target[key] = val;
  }
}

/**
 * Apply a reducer's `patches:` list to `buf` in-place and return the journal.
 *
 * Patches are applied one at a time so that each patch's CEL value sees the
 * state as mutated by the prior patches in the same list (e.g. a later patch
 * referencing `state.totalConversions` reads what an earlier patch set). Every
 * journal entry carries `source: 'reducer'`.
 */
export function applyReducerPatchList(
  buf: JsonObject,
  patches: readonly ReducerPatchOp[],
  cel: CelEvaluator,
  celCtx: Record<string, unknown>,
): JournalEntry[] {
  const journal: JournalEntry[] = [];
  for (const patch of patches) {
    const resolved = resolveReducerPatch(patch, cel, celCtx);
    const result = applyPatches(buf, [resolved], 'reducer', { autoVivify: true });
    replaceInPlace(buf, result.newState as JsonObject);
    journal.push(...result.journal);
  }
  return journal;
}
