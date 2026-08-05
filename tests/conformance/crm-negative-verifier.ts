/* eslint-disable no-console */

import * as path from 'node:path';
import { startSpecmaticTest, SpecmaticVerifierError } from '../_harness/specmatic-test';

const CONFIG_PATH = path.resolve('tests/conformance/specmatic-negative-verifier.yaml');
const FILTER = "STATUS='400'";

interface ScenarioResult {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly expectedStatus: string;
  readonly actualStatus: string;
  readonly passed: boolean;
}

function scenarios(
  result: Awaited<ReturnType<typeof startSpecmaticTest>>,
): readonly ScenarioResult[] {
  return [...(result.report.testCases ?? [])]
    .map((testCase) => ({
      name: testCase.testName,
      method: testCase.method,
      path: testCase.path,
      expectedStatus: testCase.expectedStatus,
      actualStatus: testCase.actualStatus,
      passed: testCase.passed,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function assertSuccessfulRun(
  label: string,
  result: Awaited<ReturnType<typeof startSpecmaticTest>>,
): readonly ScenarioResult[] {
  if (
    result.process.exitCode !== 0 ||
    result.process.signal ||
    result.report.tests === 0 ||
    result.report.failures > 0 ||
    result.report.errors > 0
  ) {
    throw new SpecmaticVerifierError(
      `${label} CRM Layer-A run failed: exit=${result.process.exitCode ?? 'unknown'}, tests=${result.report.tests}, failures=${result.report.failures}, errors=${result.report.errors}.`,
    );
  }
  const parsed = scenarios(result);
  if (parsed.length !== result.report.tests || parsed.some((scenario) => !scenario.passed)) {
    throw new SpecmaticVerifierError(
      `${label} CRM Layer-A JUnit report was incomplete: parsed=${parsed.length}, tests=${result.report.tests}.`,
    );
  }
  return parsed;
}

/** Run the negative CRM verifier twice and compare every testcase outcome. */
export async function verifyCrmNegative(): Promise<void> {
  const options = {
    exampleName: 'crm',
    configPath: CONFIG_PATH,
    filter: FILTER,
    testMode: 'all' as const,
    maxTestRequestCombinations: 1,
  };
  const first = assertSuccessfulRun('first', await startSpecmaticTest(options));
  const second = assertSuccessfulRun('second', await startSpecmaticTest(options));
  if (JSON.stringify(second) !== JSON.stringify(first)) {
    throw new SpecmaticVerifierError(
      `CRM Layer-A testcase outcomes were not deterministic across runs (${first.length} vs ${second.length}).`,
    );
  }
  console.log(
    `Specmatic CRM Layer-A verification passed twice: ${first.length} deterministic testcase(s), zero failures/errors.`,
  );
}

if (require.main === module) {
  verifyCrmNegative().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
