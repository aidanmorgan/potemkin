import { assertAllowlistIsUnique, evaluateAllowlist } from "./allowlist.js";
import type { ConformanceFailure, ConformanceGateOptions, SpecmaticTestResult } from "./types.js";

export class ConformanceGateFailure extends Error {
  readonly code = "CONFORMANCE_GATE_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "ConformanceGateFailure";
  }
}

function describe(
  result: SpecmaticTestResult,
  unexpected: readonly ConformanceFailure[],
  stale: readonly { id: string }[],
  allowedCount: number,
): string {
  const reportProblems: string[] = [];
  if (result.report.tests === 0)
    reportProblems.push(
      "Specmatic reported no tests; check the selected layer and --filter expression.",
    );
  if (result.report.failures > result.report.cases.length) {
    reportProblems.push(
      `JUnit reported ${result.report.failures} failure(s), but only ${result.report.cases.length} failure case(s) could be parsed.`,
    );
  }
  const lines = [
    `Specmatic conformance gate failed: ${unexpected.length} unexpected failure(s), ${stale.length} stale allowlist entr${stale.length === 1 ? "y" : "ies"}.`,
    `JUnit totals: ${result.report.tests} test(s), ${result.report.failures} failure(s), ${result.report.errors} error(s), ${result.report.skipped} skipped.`,
    `Allowlisted failures: ${allowedCount}.`,
    ...(result.report.sourceFiles.length > 0
      ? [`JUnit reports: ${result.report.sourceFiles.join(", ")}`]
      : []),
    ...reportProblems.map((problem) => `- report error: ${problem}`),
  ];
  if (result.process.exitCode !== 0 || result.process.signal) {
    lines.push(
      `Specmatic verifier terminated with ${
        result.process.signal
          ? `signal ${result.process.signal}`
          : `exit code ${result.process.exitCode ?? "unknown"}`
      }.`,
    );
    const diagnostics = [result.process.stderr.trim(), result.process.stdout.trim()]
      .filter(Boolean)
      .join("\n");
    if (diagnostics) lines.push(`Verifier diagnostics:\n${diagnostics.slice(-4000)}`);
  }
  for (const failure of unexpected) {
    const identity = [
      `${failure.method} ${failure.path}`,
      `scenario=${JSON.stringify(failure.scenario)}`,
      `expected=${failure.expectedStatus}`,
      `actual=${failure.actualStatus}`,
      ...(failure.ruleId ? [`rule=${failure.ruleId}`] : []),
    ].join(", ");
    const details = failure.details.trim().replace(/\s+/g, " ");
    lines.push(
      `- ${identity}: ${failure.testName}: ${failure.message}${details && details !== failure.message ? `; details=${details}` : ""}`,
    );
  }
  for (const entry of stale) lines.push(`- stale allowlist entry: ${entry.id}`);
  return lines.join("\n");
}

export async function runConformanceGate(
  options: ConformanceGateOptions,
): Promise<SpecmaticTestResult> {
  try {
    if (options.allowlist) assertAllowlistIsUnique(options.allowlist);
    await options.provider.reset();
    const result = await options.verifier();
    const evaluation = evaluateAllowlist(result.report.cases, options.allowlist);
    const failedWithoutReport =
      result.process.exitCode !== 0 && result.report.failures === 0 && result.report.errors === 0;
    if (
      result.report.tests === 0 ||
      result.report.failures > result.report.cases.length ||
      failedWithoutReport ||
      result.report.errors > 0 ||
      evaluation.unexpected.length > 0 ||
      evaluation.stale.length > 0
    ) {
      throw new ConformanceGateFailure(
        describe(result, evaluation.unexpected, evaluation.stale, evaluation.allowed.length),
      );
    }
    return result;
  } finally {
    await options.provider.shutdown();
  }
}
