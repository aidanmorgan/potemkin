/* eslint-disable no-console */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { startSpecmaticTest, SpecmaticVerifierError } from '../_harness/specmatic-test';

const CONFIG_PATH = path.resolve('tests/conformance/specmatic-positive-verifier.yaml');
const BY_ID_CONFIG_PATH = path.resolve('tests/conformance/specmatic-positive-by-id-verifier.yaml');
const EXAMPLES_DIR = path.resolve('tests/conformance/fixtures/crm');
const COLLECTION_FILTER = "METHOD='GET' && PATH='/leads'";
const BY_ID_FILTER = "METHOD='GET' && PATH='/leads/{id}'";

function testcaseSignature(
  result: Awaited<ReturnType<typeof startSpecmaticTest>>,
): readonly string[] {
  return [...(result.report.testCases ?? [])]
    .map((testCase) =>
      JSON.stringify({
        name: testCase.testName,
        method: testCase.method,
        path: testCase.path,
        expectedStatus: testCase.expectedStatus,
        actualStatus: testCase.actualStatus,
        passed: testCase.passed,
      }),
    )
    .sort();
}

function assertPositiveRun(
  label: string,
  result: Awaited<ReturnType<typeof startSpecmaticTest>>,
  expectedPath: string,
): readonly string[] {
  if (
    result.process.exitCode !== 0 ||
    result.process.signal ||
    result.report.tests === 0 ||
    result.report.failures > 0 ||
    result.report.errors > 0
  ) {
    throw new SpecmaticVerifierError(
      [
        `${label} CRM Layer-B run failed: exit=${result.process.exitCode ?? 'unknown'}, tests=${result.report.tests}, failures=${result.report.failures}, errors=${result.report.errors}.`,
        result.process.stderr.trim().slice(-4000),
        result.process.stdout.trim().slice(-4000),
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  const cases = result.report.testCases ?? [];
  if (
    cases.length !== result.report.tests ||
    cases.some(
      (testCase) =>
        !testCase.passed ||
        testCase.method !== 'GET' ||
        testCase.path !== expectedPath ||
        testCase.expectedStatus !== '200' ||
        testCase.actualStatus !== '200',
    )
  ) {
    throw new SpecmaticVerifierError(
      `${label} CRM Layer-B report did not contain only complete successful collection/by-id cases.`,
    );
  }
  return testcaseSignature(result);
}

/** Run the positive CRM verifier twice against local pinned fixtures. */
export async function verifyCrmPositive(): Promise<void> {
  const isolatedContractDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'potemkin-crm-layer-b-contract-'),
  );
  const isolatedContractPath = path.join(isolatedContractDir, 'nuisance-bureau.yaml');
  const isolatedExamplesDir = path.join(isolatedContractDir, 'nuisance-bureau_examples');
  await fs.copyFile(
    path.resolve('examples/crm/openapi/nuisance-bureau.yaml'),
    isolatedContractPath,
  );
  await fs.cp(EXAMPLES_DIR, isolatedExamplesDir, { recursive: true });
  const options = {
    exampleName: 'crm',
    contractPath: isolatedContractPath,
    examplesDir: isolatedExamplesDir,
    maxTestRequestCombinations: 10,
  };
  const routeResults: string[] = [];
  try {
    for (const [expectedPath, routeFilter, configPath, testMode] of [
      ['/leads', COLLECTION_FILTER, CONFIG_PATH, 'none'],
      ['/leads/{id}', BY_ID_FILTER, BY_ID_CONFIG_PATH, 'positiveOnly'],
    ] as const) {
      const first = assertPositiveRun(
        `first ${expectedPath}`,
        await startSpecmaticTest({ ...options, configPath, filter: routeFilter, testMode }),
        expectedPath,
      );
      const second = assertPositiveRun(
        `second ${expectedPath}`,
        await startSpecmaticTest({ ...options, configPath, filter: routeFilter, testMode }),
        expectedPath,
      );
      if (JSON.stringify(first) !== JSON.stringify(second)) {
        throw new SpecmaticVerifierError(
          `CRM Layer-B testcase identities/outcomes for ${expectedPath} were not deterministic (${first.length} vs ${second.length}).`,
        );
      }
      routeResults.push(`${expectedPath}: ${first.length}`);
    }
  } finally {
    await fs.rm(isolatedContractDir, { recursive: true, force: true });
  }
  console.log(
    `Specmatic CRM Layer-B verification passed twice: ${routeResults.join(', ')} deterministic seeded testcase(s).`,
  );
}

if (require.main === module) {
  verifyCrmPositive().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
