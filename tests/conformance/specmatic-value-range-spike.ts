/* eslint-disable no-console */

import * as cp from "node:child_process";
import { ensureSpecmaticJar } from "../../src/conformance/binaries.js";
import { startSpecmaticTest, SpecmaticVerifierError } from "../_harness/specmatic-test";

const SPECMATIC_VERSION = "2.46.2";

interface SpecmaticHelpResult {
  readonly stdout: string;
  readonly stderr: string;
}

function specmaticTestHelp(jarPath: string): SpecmaticHelpResult {
  const result = cp.spawnSync(
    "java",
    ["-cp", jarPath, "application.SpecmaticApplication", "test", "--help"],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new SpecmaticVerifierError(
      `Specmatic test --help exited with ${result.status}: ${result.stderr ?? ""}`,
    );
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * Run the real Specmatic test JVM while checking whether its public selector
 * surface can isolate value-range mutations. The result is intentionally a
 * hand-runnable spike, not production conformance policy.
 */
export async function runValueRangeSpike(): Promise<void> {
  const jarPath = await ensureSpecmaticJar(SPECMATIC_VERSION);
  const help = specmaticTestHelp(jarPath);
  const supportedFilterKeys = [...help.stdout.matchAll(/^\s+- `([A-Z]+)`:/gm)].map(
    (match) => match[1],
  );

  const result = await startSpecmaticTest({
    exampleName: "crm",
    testMode: "all",
    filter: "METHOD='POST' && PATH='/leads'",
    maxTestRequestCombinations: 1,
  });

  if (result.process.signal !== null || result.report.tests === 0) {
    throw new SpecmaticVerifierError(
      [
        `The bounded CRM generative probe did not complete: exit=${result.process.exitCode ?? "unknown"}.`,
        result.process.stderr.trim(),
        result.process.stdout.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const hasGeneratorClassSelector = /value[-_ ]?range|resilien(?:cy|ce)[-_ ]?class/i.test(
    help.stdout,
  );
  if (hasGeneratorClassSelector) {
    throw new SpecmaticVerifierError(
      "The spike detected a generator-class selector; update the determination before routing cases to an allowlist.",
    );
  }

  console.log(`Specmatic ${SPECMATIC_VERSION} filter keys: ${supportedFilterKeys.join(", ")}`);
  console.log(
    `Bounded CRM generative probe: ${result.report.tests} test(s), ${result.report.failures} failure(s).`,
  );
  console.log(
    "Determination: value-range mutations cannot be isolated by the Specmatic 2.46.2 test CLI/config; route only exact, evidenced divergences to Layer C allowlist entries.",
  );
}

if (require.main === module) {
  runValueRangeSpike().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
