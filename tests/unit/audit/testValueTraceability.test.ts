import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { policyForTestFile, TEST_VALUE_POLICIES } from "../../_support/testValueInventory.js";

function filesUnder(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const file = path.join(root, entry);
    if (statSync(file).isDirectory()) files.push(...filesUnder(file));
    else files.push(file);
  }
  return files;
}

function testFiles(root: string): string[] {
  return ["tests", "examples", "plugin/src/test"]
    .flatMap((directory) => filesUnder(path.join(root, directory)))
    .filter((file) => {
      const relative = path.relative(root, file).split(path.sep).join("/");
      return (
        /\.(test|spec)\.(ts|kt|js)$/.test(relative) ||
        relative.endsWith("Test.kt") ||
        relative.endsWith(".feature")
      );
    });
}

describe("test value and traceability inventory", () => {
  it("assigns every test artifact to one explicit value policy", () => {
    const root = process.cwd();
    const unmatched = testFiles(root)
      .filter((file) => policyForTestFile(root, file) === undefined)
      .map((file) => path.relative(root, file).split(path.sep).join("/"));

    expect(unmatched).toEqual([]);
  });

  it("keeps every policy backed by a canonical evidence test and a boundary", () => {
    const root = process.cwd();
    const missing = TEST_VALUE_POLICIES.flatMap((policy) => {
      const missingTests = policy.canonicalTests
        .filter((test) => !existsSync(path.join(root, test)))
        .map((test) => `${policy.id}: missing ${test}`);
      return policy.canonicalBoundary.length === 0
        ? [...missingTests, `${policy.id}: missing canonical boundary`]
        : missingTests;
    });

    expect(missing).toEqual([]);
  });

  it("keeps the high-coverage gate explicit and no-skip enforcement in the package contract", () => {
    const packageJson = require(path.join(process.cwd(), "package.json")) as {
      scripts?: Record<string, string>;
    };
    const jestConfig = require(path.join(process.cwd(), "jest.config.js")) as {
      coverageThreshold?: { global?: Record<string, number> };
    };

    expect(packageJson.scripts?.["test:coverage"]).toContain("--coverage");
    expect(packageJson.scripts?.["verify:no-skips"]).toBeDefined();
    expect(jestConfig.coverageThreshold?.global).toEqual({
      statements: expect.any(Number),
      branches: expect.any(Number),
      functions: expect.any(Number),
      lines: expect.any(Number),
    });
    for (const threshold of Object.values(jestConfig.coverageThreshold!.global!)) {
      expect(threshold).toBeGreaterThanOrEqual(80);
    }
  });
});
