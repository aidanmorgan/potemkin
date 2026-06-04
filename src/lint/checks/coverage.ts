/**
 * Coverage check (WARNING-only): every OpenAPI operation that has no boundary is
 * served by the `fallback:` policy (501/404/custom). That is intentional for a
 * partial simulation of a large spec, so it is a warning — visible, not blocking.
 */
import type { LintCheck, LintContext, LintFinding } from '../types.js';
import { lintWarning } from '../types.js';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export const coverageCheck: LintCheck = (ctx: LintContext): readonly LintFinding[] => {
  const boundedPaths = new Set(Object.keys(ctx.dsl.byContractPath));
  for (const b of ctx.dsl.boundaries) boundedPaths.add(b.contractPath);

  const paths = isRecord(ctx.openapi.raw) ? ctx.openapi.raw['paths'] : undefined;
  if (!isRecord(paths)) return [];

  const findings: LintFinding[] = [];
  for (const [path, itemRaw] of Object.entries(paths)) {
    if (boundedPaths.has(path) || !isRecord(itemRaw)) continue;
    for (const method of HTTP_METHODS) {
      const op = itemRaw[method];
      if (!isRecord(op)) continue;
      const opId = typeof op['operationId'] === 'string' ? ` (${op['operationId']})` : '';
      findings.push(
        lintWarning(
          'UNBOUNDED_OPERATION',
          `${method.toUpperCase()} ${path}${opId} has no boundary — served by the fallback policy`,
          { pointer: `${method.toUpperCase()} ${path}` },
        ),
      );
    }
  }
  return findings;
};
