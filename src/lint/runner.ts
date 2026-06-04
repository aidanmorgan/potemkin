/**
 * Lint runner + report formatter + boot integration.
 *
 * Runs every registered check against the composed model, partitions findings
 * into errors/warnings, and (at boot) aborts with a located report when any
 * error is present. Warnings are returned for the caller to log.
 */
import { BootError } from '../errors.js';
import type { LintCheck, LintContext, LintFinding } from './types.js';

export interface LintResult {
  readonly errors: readonly LintFinding[];
  readonly warnings: readonly LintFinding[];
}

/** Run all checks (each isolated so one throwing check can't abort the rest). */
export function runLint(ctx: LintContext, checks: readonly LintCheck[]): LintResult {
  const findings: LintFinding[] = [];
  for (const check of checks) {
    try {
      findings.push(...check(ctx));
    } catch (err) {
      // A check that throws is itself a defect; surface it as an error finding
      // rather than letting it abort the whole lint pass.
      findings.push({
        severity: 'error',
        code: 'LINT_CHECK_FAILED',
        message: `lint check threw: ${err instanceof Error ? err.message : String(err)}`,
        location: {},
      });
    }
  }
  return {
    errors: findings.filter((f) => f.severity === 'error'),
    warnings: findings.filter((f) => f.severity === 'warning'),
  };
}

function locationSuffix(f: LintFinding): string {
  const parts: string[] = [];
  if (f.location.file) parts.push(f.location.file);
  if (f.location.boundary) parts.push(`boundary '${f.location.boundary}'`);
  if (f.location.pointer) parts.push(f.location.pointer);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/** A grouped, located, human-readable report for a set of findings. */
export function formatFindings(title: string, findings: readonly LintFinding[]): string {
  const lines = [title];
  for (const f of findings) {
    lines.push(`  [${f.code}]${locationSuffix(f)}`);
    lines.push(`    ${f.message}`);
  }
  return lines.join('\n');
}

/**
 * Boot gate: run the lint and, when any error is present, throw a BootError with
 * the full located report so the engine refuses to start. Returns the warnings
 * for the caller to log.
 */
export function lintOrThrow(ctx: LintContext, checks: readonly LintCheck[]): readonly LintFinding[] {
  const { errors, warnings } = runLint(ctx, checks);
  if (errors.length > 0) {
    throw new BootError(
      'BOOT_ERR_LINT',
      formatFindings(`Configuration linting failed with ${errors.length} error(s):`, errors),
      {
        errorCount: errors.length,
        findings: errors.map((f) => ({ code: f.code, message: f.message, ...f.location })),
      },
    );
  }
  return warnings;
}
