import { BootError } from '../errors.js';
import { ALL_CHECKS } from './checks/index.js';
import type { LintCheck, LintContext, LintFinding } from './types.js';

export interface LintResult {
  readonly errors: readonly LintFinding[];
  readonly warnings: readonly LintFinding[];
}

/** Run every registered check against one source-neutral runtime model. */
export function runLint(
  context: LintContext,
  checks: readonly LintCheck[] = ALL_CHECKS,
): LintResult {
  const findings = checks.flatMap((check) => {
    try {
      return [...check(context)];
    } catch (error) {
      return [
        {
          severity: 'error' as const,
          code: 'LINT_CHECK_FAILED',
          message: error instanceof Error ? error.message : String(error),
          location: {},
        },
      ];
    }
  });
  return {
    errors: findings.filter((finding) => finding.severity === 'error'),
    warnings: findings.filter((finding) => finding.severity === 'warning'),
  };
}

export function formatFindings(title: string, findings: readonly LintFinding[]): string {
  return [
    title,
    ...findings.flatMap((finding) => [
      `  [${finding.code}]${formatLocation(finding)}`,
      `    ${finding.message}`,
    ]),
  ].join('\n');
}

/** Apply the strict boot gate and return non-fatal warnings. */
export function lintOrThrow(
  context: LintContext,
  checks: readonly LintCheck[] = ALL_CHECKS,
): readonly LintFinding[] {
  const result = runLint(context, checks);
  if (result.errors.length > 0) {
    throw new BootError(
      'BOOT_ERR_DSL_SCHEMA_VIOLATION',
      formatFindings(
        `Configuration linting failed with ${result.errors.length} error(s):`,
        result.errors,
      ),
      {
        errorCount: result.errors.length,
        findings: result.errors.map((finding) => ({
          code: finding.code,
          message: finding.message,
          ...finding.location,
        })),
      },
    );
  }
  return result.warnings;
}

function formatLocation(finding: LintFinding): string {
  const parts = [
    finding.location.file,
    finding.location.boundary === undefined ? undefined : `boundary '${finding.location.boundary}'`,
    finding.location.pointer,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}
