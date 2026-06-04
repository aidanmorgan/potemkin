/**
 * Required-field response coverage.
 *
 * A creation boundary (one that generates new aggregates via identity.creation)
 * must, through the reducer for each event its behaviors emit, set every REQUIRED
 * field of the boundary's state schema. Otherwise the freshly-created entity is
 * missing a required field and fails contract validation at request time (a 500).
 * This surfaces that at boot.
 *
 * A field counts as "set" by the create reducer when:
 *   - the reducer uses replace_state (state := the event payload) and the event's
 *     payload_template declares the field, OR
 *   - a patch addresses the field (its first path segment).
 */
import type { BoundaryConfig, ReducerRule } from '../../dsl/types.js';
import type { LintCheck, LintContext, LintFinding } from '../types.js';
import { lintError } from '../types.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** required[] + properties for a boundary's resolved state schema. */
function schemaInfo(ctx: LintContext, schemaName: string): { required: string[] } | null {
  const components = isRecord(ctx.openapi.raw) ? ctx.openapi.raw['components'] : undefined;
  const schemas = isRecord(components) ? components['schemas'] : undefined;
  if (!isRecord(schemas)) return null;
  let schema = schemas[schemaName];
  if (isRecord(schema) && typeof schema['$ref'] === 'string') {
    const m = /^#\/components\/schemas\/(.+)$/.exec(schema['$ref']);
    if (m) schema = schemas[m[1]];
  }
  if (!isRecord(schema) || !Array.isArray(schema['required'])) return null;
  return { required: (schema['required'] as unknown[]).filter((r): r is string => typeof r === 'string') };
}

/**
 * Top-level field names a reducer sets, or null when the reducer can't be
 * analysed statically (a registered TypeScript reducer sets fields in code).
 */
function fieldsSetBy(reducer: ReducerRule, boundary: BoundaryConfig): Set<string> | null {
  if (reducer.implementation === 'typescript') return null;
  const set = new Set<string>();
  if (reducer.replaceState) {
    const event = boundary.eventCatalog.find((e) => e.type === reducer.on);
    for (const key of Object.keys(event?.payloadTemplate ?? {})) set.add(key);
  }
  for (const patch of reducer.patches ?? []) {
    const seg = patch.path.replace(/^\//, '').split('/')[0];
    if (seg.length > 0) set.add(decodeURIComponent(seg.replace(/~1/g, '/').replace(/~0/g, '~')));
  }
  return set;
}

export const requiredFieldsCheck: LintCheck = (ctx: LintContext): readonly LintFinding[] => {
  const findings: LintFinding[] = [];
  for (const b of ctx.dsl.boundaries) {
    if (b.identity?.creation === undefined) continue; // only creation boundaries mint entities
    const info = schemaInfo(ctx, b.schema ?? b.boundary);
    if (info === null || info.required.length === 0) continue;

    // Consider the reducers for the events this boundary's behaviors emit (the
    // create path). Reaction-created boundaries have no behaviors -> nothing to
    // judge here.
    const emitted = new Set(b.behaviors.flatMap((bh) => (bh.emit ? [bh.emit] : [])));
    const set = new Set<string>();
    let analyzable = false;
    for (const r of b.reducers) {
      if (!emitted.has(r.on)) continue;
      const fields = fieldsSetBy(r, b);
      if (fields === null) { analyzable = false; break; } // a TS reducer is opaque — don't judge
      analyzable = true;
      for (const f of fields) set.add(f);
    }
    if (!analyzable || set.size === 0) continue;

    // `id` is set by the engine from the aggregate targetId, not the reducer.
    const required = info.required.filter((f) => f !== 'id');
    const missing = required.filter((f) => !set.has(f));
    if (missing.length > 0) {
      findings.push(
        lintError(
          'REQUIRED_FIELD_UNSET',
          `creation does not set required schema field(s) [${missing.join(', ')}] — a created entity would fail contract validation`,
          {
            ...(ctx.boundarySourcePaths?.[b.boundary] ? { file: ctx.boundarySourcePaths[b.boundary] } : {}),
            boundary: b.boundary,
            pointer: 'reducers',
          },
        ),
      );
    }
  }
  return findings;
};
