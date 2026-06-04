/**
 * Referential-integrity lint for references the parse-time validation does NOT
 * already cover.
 *
 * The major references are enforced at boot by existing validation (which throws
 * BOOT_ERR_DSL_REFERENCE before the lint runs): behavior `emit` / `emit_when`
 * and reducer `on` against the event_catalog (crossValidate), reaction `on`/`emit`
 * (validateReactionCrossReferences), `match.operationId` (validateBehaviorOperationIds),
 * and event `schema_ref` (boot). This check covers what those do not: a `mask:`
 * field that names a property the boundary's state schema does not have masks
 * nothing — almost always a typo — so flag it.
 */
import type { LintCheck, LintContext, LintFinding } from '../types.js';
import { lintError } from '../types.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Property names of a boundary's resolved state schema, or null if unavailable. */
function schemaPropertyNames(ctx: LintContext, schemaName: string): Set<string> | null {
  const schemas = isRecord(ctx.openapi.raw)
    ? isRecord(ctx.openapi.raw['components'])
      ? (ctx.openapi.raw['components'] as Record<string, unknown>)['schemas']
      : undefined
    : undefined;
  if (!isRecord(schemas)) return null;
  let schema = schemas[schemaName];
  // Follow one local $ref hop (the boundary alias pattern).
  if (isRecord(schema) && typeof schema['$ref'] === 'string') {
    const m = /^#\/components\/schemas\/(.+)$/.exec(schema['$ref']);
    if (m) schema = schemas[m[1]];
  }
  // additionalProperties:true schemas accept any field — nothing to verify against.
  if (!isRecord(schema) || schema['additionalProperties'] === true) return null;
  const props = schema['properties'];
  return isRecord(props) ? new Set(Object.keys(props)) : null;
}

export const referencesCheck: LintCheck = (ctx: LintContext): readonly LintFinding[] => {
  const findings: LintFinding[] = [];
  for (const b of ctx.dsl.boundaries) {
    const props = schemaPropertyNames(ctx, b.schema ?? b.boundary);
    if (props === null) continue; // open/unknown schema — cannot verify
    const file = ctx.boundarySourcePaths?.[b.boundary];
    const loc = (pointer: string) => ({ ...(file ? { file } : {}), boundary: b.boundary, pointer });

    for (const field of b.mask ?? []) {
      if (!props.has(field)) {
        findings.push(lintError('MASK_FIELD_UNKNOWN', `mask references field '${field}' that is not a property of schema '${b.schema ?? b.boundary}'`, loc(`mask[${field}]`)));
      }
    }
  }
  return findings;
};
