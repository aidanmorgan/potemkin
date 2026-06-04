import { runLint, formatFindings, lintOrThrow } from '../../../src/lint/runner';
import { lintError, lintWarning, type LintCheck, type LintContext } from '../../../src/lint/types';

const ctx = {} as LintContext;

describe('lint runner', () => {
  it('partitions findings into errors and warnings', () => {
    const checks: LintCheck[] = [
      () => [lintError('A', 'an error', { boundary: 'X', pointer: 'reducers[0]' })],
      () => [lintWarning('B', 'a warning')],
    ];
    const { errors, warnings } = runLint(ctx, checks);
    expect(errors).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(errors[0].code).toBe('A');
  });

  it('a throwing check becomes a LINT_CHECK_FAILED error, not an abort', () => {
    const checks: LintCheck[] = [
      () => { throw new Error('boom'); },
      () => [lintWarning('OK', 'still runs')],
    ];
    const { errors, warnings } = runLint(ctx, checks);
    expect(errors[0].code).toBe('LINT_CHECK_FAILED');
    expect(warnings).toHaveLength(1); // later check still ran
  });

  it('formatFindings produces a located, grouped report', () => {
    const report = formatFindings('Problems:', [
      lintError('REF', 'no such event', { file: 'customer.yaml', boundary: 'cust', pointer: 'reducers[0].on' }),
    ]);
    expect(report).toContain('[REF]');
    expect(report).toContain("customer.yaml, boundary 'cust', reducers[0].on");
    expect(report).toContain('no such event');
  });

  it('lintOrThrow throws BOOT_ERR_LINT on errors and returns warnings otherwise', () => {
    expect(() => lintOrThrow(ctx, [() => [lintError('E', 'bad')]])).toThrow(/Configuration linting failed with 1 error/);
    const warnings = lintOrThrow(ctx, [() => [lintWarning('W', 'meh')]]);
    expect(warnings).toHaveLength(1);
  });
});
