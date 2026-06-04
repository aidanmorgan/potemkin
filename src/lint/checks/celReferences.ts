/**
 * CEL reference static analysis (high-confidence subset).
 *
 * A reducer patch value that reads `event.payload.<field>` must reference a field
 * the reducer's event actually declares in its `payload_template`. A reference to
 * a field the event does not emit is always a typo (e.g. `event.payload.emial`)
 * and silently yields null at runtime, so flag it at boot.
 *
 * Scoped to event.payload references against the event's own declared payload —
 * the one place where the source of truth (the payload_template keys) is exact,
 * so the check has no false positives. (ts: script references and event/operation
 * references are validated elsewhere at boot.)
 */
import type { LintCheck, LintContext, LintFinding } from '../types.js';
import { lintError } from '../types.js';

const EVENT_PAYLOAD_REF = /event\.payload\.([A-Za-z_][A-Za-z0-9_]*)/g;

function extractRefs(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const refs: string[] = [];
  let m: RegExpExecArray | null;
  EVENT_PAYLOAD_REF.lastIndex = 0;
  while ((m = EVENT_PAYLOAD_REF.exec(text)) !== null) refs.push(m[1]);
  return refs;
}

export const celReferencesCheck: LintCheck = (ctx: LintContext): readonly LintFinding[] => {
  const findings: LintFinding[] = [];
  for (const b of ctx.dsl.boundaries) {
    const eventByType = new Map(b.eventCatalog.map((e) => [e.type, e]));
    const file = ctx.boundarySourcePaths?.[b.boundary];
    for (const r of b.reducers) {
      if (r.implementation === 'typescript' || r.patches === undefined) continue;
      const event = eventByType.get(r.on);
      if (event === undefined) continue; // dangling reducer.on is reported by crossValidate
      const payloadKeys = new Set(Object.keys(event.payloadTemplate ?? {}));
      for (const patch of r.patches) {
        for (const ref of extractRefs(patch.value)) {
          if (!payloadKeys.has(ref)) {
            findings.push(
              lintError(
                'CEL_EVENT_PAYLOAD_REF_UNKNOWN',
                `reducer for '${r.on}' references event.payload.${ref}, which the '${r.on}' event payload_template does not declare`,
                {
                  ...(file ? { file } : {}),
                  boundary: b.boundary,
                  pointer: `reducers[on=${r.on}] ${patch.path}`,
                },
              ),
            );
          }
        }
      }
    }
  }
  return findings;
};
