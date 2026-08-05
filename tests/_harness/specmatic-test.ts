/**
 * Real Specmatic test-mode verifier harness.
 *
 * The provider is the consumer-facing Specmatic stub returned by
 * startExampleStack. The verifier is a second, independent Specmatic JVM in
 * `test` mode. Consequently every generated request follows the same path a
 * consumer uses: Specmatic test JVM -> Specmatic stub -> Potemkin plugin ->
 * Potemkin engine.
 */

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureSpecmaticJar } from '../../src/conformance/binaries.js';
import { startExampleStack } from '../../src/conformance/exampleStack.js';
import { runSpecmaticTest } from '../../src/conformance/specmatic';
import type { SpecmaticTestResult } from '../../src/conformance/types';

const SPECMATIC_VERSION = '2.46.2';

export interface SpecmaticTestHarnessOptions {
  /** Example directory under examples/, normally `crm`. */
  readonly exampleName: string;
  /** Override the example contract when a hand-run verifier needs a fixture. */
  readonly contractPath?: string;
  /** Existing JUnit directory. Defaults to a temporary directory. */
  readonly junitReportDir?: string;
  /** Specmatic v3 settings file used by the verifier JVM. */
  readonly configPath?: string;
  /** Explicit JAR path, primarily useful for isolated tests. */
  readonly jarPath?: string;
  readonly filter?: string;
  readonly testMode?: 'all' | 'positiveOnly' | 'none';
  readonly maxTestRequestCombinations?: number;
  readonly examplesDir?: string;
}

export class SpecmaticVerifierError extends Error {
  readonly code = 'SPECMATIC_VERIFIER_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'SpecmaticVerifierError';
  }
}

function resolveContract(exampleName: string): string {
  const directory = path.resolve('examples', exampleName, 'openapi');
  const files = fs
    .readdirSync(directory)
    .filter((file) => /\.(yaml|yml|json)$/i.test(file))
    .sort();
  if (files.length !== 1) {
    throw new SpecmaticVerifierError(
      `Expected exactly one OpenAPI contract in ${directory}; found ${files.length}`,
    );
  }
  return path.join(directory, files[0]);
}

/**
 * Boots an example and runs a separate Specmatic test JVM against its stub.
 * The example stack is always shut down before this function resolves or
 * rejects; the returned process/report are therefore safe to inspect without
 * owning a live server.
 */
export async function startSpecmaticTest(
  options: SpecmaticTestHarnessOptions,
): Promise<SpecmaticTestResult> {
  const contractPath = options.contractPath ?? resolveContract(options.exampleName);
  const junitReportDir =
    options.junitReportDir ??
    (await fsPromises.mkdtemp(path.join(os.tmpdir(), 'potemkin-specmatic-test-')));
  const jarPath = options.jarPath ?? (await ensureSpecmaticJar(SPECMATIC_VERSION));
  const stack = await startExampleStack({
    exampleName: options.exampleName,
    ...(options.examplesDir === undefined ? {} : { seedExamplesDir: options.examplesDir }),
  });

  try {
    return await runSpecmaticTest({
      jarPath,
      testBaseUrl: stack.stubUrl,
      contractPath,
      junitReportDir,
      ...(options.configPath ? { configPath: options.configPath } : {}),
      ...(options.examplesDir ? { examplesDir: options.examplesDir } : {}),
      ...(options.filter ? { filter: options.filter } : {}),
      ...(options.testMode !== undefined ? { testMode: options.testMode } : {}),
      ...(options.maxTestRequestCombinations !== undefined
        ? { maxTestRequestCombinations: options.maxTestRequestCombinations }
        : {}),
      env: process.env,
    });
  } finally {
    await stack.shutdown();
  }
}
