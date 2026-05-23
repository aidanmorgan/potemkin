import type { JsonValue } from '../types.js';
import type { ObjectGraphSchemaRegistry } from './types.js';
import { resolvePath } from './pathResolver.js';
import { isAssignable } from './typeCheck.js';
import { InternalExecutionError } from '../errors.js';

/**
 * Throws `InternalExecutionError` (SCHEMA_PATH_UNKNOWN) if `dotPath` does not
 * exist in the entity schema for `boundary`.
 */
export function guardAssignPath(
  registry: ObjectGraphSchemaRegistry,
  boundary: string,
  dotPath: string,
): void {
  const bs = registry.get(boundary);
  if (!bs) {
    throw new InternalExecutionError(
      `SCHEMA_PATH_UNKNOWN: no schema for boundary '${boundary}'`,
      { code: 'SCHEMA_PATH_UNKNOWN', boundary, dotPath },
    );
  }
  const resolved = resolvePath(bs.entity, dotPath);
  if (resolved === null) {
    throw new InternalExecutionError(
      `SCHEMA_PATH_UNKNOWN: path '${dotPath}' does not exist in schema for boundary '${boundary}'`,
      { code: 'SCHEMA_PATH_UNKNOWN', boundary, dotPath },
    );
  }
}

/**
 * Throws `InternalExecutionError` (SCHEMA_TYPE_MISMATCH) if `value` is not
 * assignable to the schema at `dotPath` for `boundary`.
 * Silently returns if the path does not exist (call guardAssignPath first).
 */
export function guardAssignedValue(
  registry: ObjectGraphSchemaRegistry,
  boundary: string,
  dotPath: string,
  value: JsonValue,
): void {
  const bs = registry.get(boundary);
  if (!bs) return; // boundary unknown — let guardAssignPath handle it

  const targetSchema = resolvePath(bs.entity, dotPath);
  if (targetSchema === null) return; // path unknown — let guardAssignPath handle it

  if (!isAssignable(value, targetSchema)) {
    throw new InternalExecutionError(
      `SCHEMA_TYPE_MISMATCH: value ${JSON.stringify(value)} is not assignable to '${dotPath}' (expected ${targetSchema.kind}) in boundary '${boundary}'`,
      { code: 'SCHEMA_TYPE_MISMATCH', boundary, dotPath, expectedKind: targetSchema.kind },
    );
  }
}
