/**
 * Identity & state completeness check.
 *
 * A boundary on a parameterized contract path (e.g. /v1/customers/{customer})
 * that mutates state via behaviors MUST be able to locate its aggregate — it
 * needs an `identity.key` (or the implicit `{id}` path fallback). Without it the
 * engine cannot resolve the target aggregate and fails at request time, so we
 * surface it at boot.
 */
import type { LintCheck, LintContext, LintFinding } from '../types.js';
import { lintError } from '../types.js';

function lastPathParam(path: string): string | undefined {
  const all = [...path.matchAll(/\{([^}]+)\}/g)];
  return all.length > 0 ? all[all.length - 1][1] : undefined;
}

export const identityCheck: LintCheck = (ctx: LintContext): readonly LintFinding[] => {
  const findings: LintFinding[] = [];
  for (const b of ctx.dsl.boundaries) {
    const param = lastPathParam(b.contractPath);
    const hasMutationBehaviors = b.behaviors.length > 0;
    if (param === undefined || !hasMutationBehaviors) continue;

    const hasKey = b.identity?.key !== undefined;
    // The implicit `{id}`-named path fallback can extract the key without an
    // explicit identity.key; any other param name requires identity.key.
    const coveredByImplicitFallback = param === 'id';
    if (!hasKey && !coveredByImplicitFallback) {
      findings.push(
        lintError(
          'IDENTITY_KEY_MISSING',
          `boundary mutates a parameterized path '${b.contractPath}' but declares no identity.key to locate the aggregate from path param '{${param}}'`,
          {
            ...(ctx.boundarySourcePaths?.[b.boundary] ? { file: ctx.boundarySourcePaths[b.boundary] } : {}),
            boundary: b.boundary,
            pointer: 'identity.key',
          },
        ),
      );
    }
  }
  return findings;
};
