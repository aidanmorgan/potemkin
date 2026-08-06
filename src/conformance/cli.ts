/* eslint-disable no-console */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureSpecmaticJar } from './binaries.js';
import { startExampleStack } from './exampleStack.js';
import { loadAllowlists, selectAllowlist } from './allowlist.js';
import {
  parseArgs,
  specmaticOptionsForLayer,
  ConformanceHelpRequested,
  type CliOptions,
  type SpecmaticLayerOptions,
} from './cli-options.js';
import { runConformanceGate } from './gate.js';
import { runSpecmaticTest } from './specmatic.js';

export { parseArgs, specmaticOptionsForLayer };
export type { CliOptions, SpecmaticLayerOptions };
export { ConformanceHelpRequested };

function resolveContract(exampleName: string): string {
  const directory = path.resolve('examples', exampleName, 'openapi');
  const files = fs.readdirSync(directory).filter((file) => /\.(yaml|yml|json)$/i.test(file));
  if (files.length !== 1)
    throw new Error(`Expected exactly one OpenAPI contract in ${directory}; found ${files.length}`);
  return path.join(directory, files[0]);
}

export function resolveSpecmaticContract(
  exampleName: string,
  layer: CliOptions['layer'],
  authoritativeContractPath: string,
): string {
  // The official Stripe OpenAPI document is the engine/stub contract, but the
  // pinned Specmatic test JVM cannot parse it because it exceeds its document
  // size limit. Keep the test contract explicit and source-controlled for the
  // blocking Layer-A run; the runtime still boots from the authoritative file.
  if (exampleName === 'stripe' && layer === 'negative') {
    const layerContract = path.resolve('examples', 'stripe', 'conformance', 'layer-a.yaml');
    if (fs.existsSync(layerContract)) return layerContract;
  }
  return authoritativeContractPath;
}

export async function runConformance(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const options = parseArgs(argv);
  const contractPath = resolveContract(options.exampleName);
  const specmaticContractPath =
    options.specmaticContractPath ??
    resolveSpecmaticContract(options.exampleName, options.layer, contractPath);
  const defaultAllowlist = path.resolve(
    'examples',
    options.exampleName,
    'conformance',
    'allow.yaml',
  );
  const allowlistPath =
    options.allowlistPath ?? (fs.existsSync(defaultAllowlist) ? defaultAllowlist : undefined);
  const allowlist = allowlistPath
    ? selectAllowlist(
        await loadAllowlists(allowlistPath),
        options.allowlistName ??
          `${options.exampleName}-${options.layer === 'positive' ? 'layer-c' : 'negative'}`,
      )
    : undefined;
  const reportDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'potemkin-specmatic-report-'));
  const layerOptions: SpecmaticLayerOptions = specmaticOptionsForLayer(
    options.layer,
    options.filter,
  );
  // Externalized examples are positive snapshots. Feeding them to the
  // generative negative layer makes Specmatic mutate a known-good request and
  // then expect a 4xx response from the snapshot, producing false failures.
  // Positive runs use the corpus to pin seeded reads and stateful examples.
  const examplesDir = path.join(
    path.dirname(contractPath),
    `${path.basename(contractPath, path.extname(contractPath))}_examples`,
  );
  let stack: Awaited<ReturnType<typeof startExampleStack>> | undefined;
  let gateInvoked = false;
  try {
    stack = await startExampleStack({
      exampleName: options.exampleName,
      ...(specmaticContractPath !== contractPath ? { specmaticContractPath } : {}),
      ...(options.layer === 'positive' && fs.existsSync(examplesDir)
        ? { seedExamplesDir: examplesDir }
        : {}),
    });
    const activeStack = stack;
    const jarPath = await ensureSpecmaticJar('2.46.2');
    gateInvoked = true;
    const result = await runConformanceGate({
      provider: {
        baseUrl: activeStack.stubUrl,
        reset: () => activeStack.reset(),
        shutdown: () => activeStack.shutdown(),
      },
      allowlist,
      verifier: () =>
        runSpecmaticTest({
          jarPath,
          testBaseUrl: activeStack.stubUrl,
          contractPath: specmaticContractPath,
          junitReportDir: reportDir,
          filter: layerOptions.filter,
          ...(options.layer === 'positive' && fs.existsSync(examplesDir) ? { examplesDir } : {}),
          testMode: layerOptions.testMode,
          env: process.env,
          maxTestRequestCombinations: options.maxCombinations,
        }),
    });
    console.log(
      `Specmatic conformance passed: ${result.report.tests} test(s), report at ${reportDir}`,
    );
  } finally {
    // runConformanceGate owns normal teardown. This catch-all covers failures
    // before the verifier starts, such as a missing Java/JAR/provider boot.
    if (stack && !gateInvoked)
      await stack.shutdown().catch(() => {
        /* preserve the original error */
      });
  }
}
