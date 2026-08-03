import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { ConsumerClient } from "../../../examples/_harness/consumer-client";

function sourceFiles(root: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const file = path.join(root, entry);
    if (statSync(file).isDirectory()) files.push(...sourceFiles(file));
    else if (/\.(ts|tsx|kt|kts)$/.test(file)) files.push(file);
  }
  return files;
}

function relativeSourceFiles(root: string): readonly [string, string][] {
  return sourceFiles(root).map((file) => [
    path.relative(process.cwd(), file),
    readFileSync(file, "utf8"),
  ]);
}

function executableSource(source: string): string {
  return source.replace(/\/\/.*$/gm, "");
}

describe("dependency and legacy-surface boundaries", () => {
  it("contains no removed runtime surfaces or registration concepts", () => {
    const roots = [path.resolve(process.cwd(), "src"), path.resolve(process.cwd(), "plugin")];
    const pathViolations = roots
      .flatMap((root) => sourceFiles(root))
      .filter((file) => /(?:adapter|shim|legacy|compat)/i.test(path.basename(file)))
      .map((file) => `${path.relative(process.cwd(), file)}: removed surface filename`);
    const sourceViolations = roots.flatMap((root) =>
      relativeSourceFiles(root).flatMap(([file, source]) => {
        const matches = [
          /runtimeAdapter/i,
          /runtime adapter/i,
          /@Script\b/,
          /compatibility\s+alias/i,
          /alias\s+compatibility/i,
          /compatibility boot/i,
          /backward compat/i,
          /backwards compat/i,
          /\bshim\b/i,
        ].filter((pattern) => pattern.test(source));
        return matches.map((pattern) => `${file}: ${pattern}`);
      }),
    );
    expect([...pathViolations, ...sourceViolations]).toEqual([]);
  });

  it("keeps process-environment reads at executable composition boundaries", () => {
    const allowed = new Set([
      "src/cli/server.ts",
      "src/conformance/cli.ts",
      "src/conformance/exampleStack.ts",
      "src/conformance/specmaticProcess.ts",
      "src/http/bindHost.ts",
    ]);
    const violations = relativeSourceFiles(path.resolve(process.cwd(), "src"))
      .filter(([file, source]) => /process\.env/.test(source) && !allowed.has(file))
      .map(([file]) => file);
    expect(violations).toEqual([]);
  });

  it("keeps native time, randomness, and timer access in documented providers", () => {
    const allowed = new Set([
      "src/cel/builtins.ts",
      "src/cel/evaluator.ts",
      "src/core/engine.ts",
      "src/lifecycle/gracefulShutdown.ts",
      "src/parser/configuredWatcher.ts",
      "src/conformance/exampleStack.ts",
      "src/conformance/specmaticProcess.ts",
      "src/runtime/host.ts",
    ]);
    const patterns = [
      /Date\.now\(/,
      /Math\.random\(/,
      /(?<![A-Za-z.])set(?:Interval|Timeout)\(/,
      /(?<![A-Za-z.])clear(?:Interval|Timeout)\(/,
    ];
    const violations = relativeSourceFiles(path.resolve(process.cwd(), "src"))
      .filter(
        ([file, source]) =>
          patterns.some((pattern) => pattern.test(executableSource(source))) && !allowed.has(file),
      )
      .map(([file]) => file);
    expect(violations).toEqual([]);
  });

  it("does not introduce static implementation methods outside the discovery contract", () => {
    const violations = relativeSourceFiles(path.resolve(process.cwd(), "src")).flatMap(
      ([file, source]) => {
        const sourceFile = ts.createSourceFile(
          file,
          source,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS,
        );
        const found: string[] = [];

        const visit = (node: ts.Node): void => {
          if (ts.isMethodDeclaration(node) && hasStaticModifier(node)) {
            const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
            const isDiscoveryMethod = decorators?.some((decorator) => {
              const expression = decorator.expression;
              return (
                ts.isCallExpression(expression) &&
                ts.isIdentifier(expression.expression) &&
                expression.expression.text === "PotemkinConfigure"
              );
            });
            if (!isDiscoveryMethod) {
              found.push(`${file}:${sourceFile.getLineAndCharacterOfPosition(node.pos).line + 1}`);
            }
          }
          ts.forEachChild(node, visit);
        };

        visit(sourceFile);
        return found;
      },
    );
    expect(violations).toEqual([]);
  });

  it("keeps Specmatic/conformance infrastructure out of test and example support paths", () => {
    const root = path.resolve(process.cwd(), "src", "conformance");
    const violations = relativeSourceFiles(root)
      .filter(([, source]) => /from\s+["'][^"']*(?:tests|examples)[^"']*["']/.test(source))
      .map(([file]) => file);
    expect(violations).toEqual([]);
  });

  it("keeps Stripe behavior tests contract-backed and network-free", () => {
    const roots = [
      path.resolve(process.cwd(), "tests", "equivalence"),
      path.resolve(process.cwd(), "tests", "integration", "equivalence"),
      path.resolve(process.cwd(), "tests", "unit", "equivalence"),
      path.resolve(process.cwd(), "examples", "stripe", "tests"),
      path.resolve(process.cwd(), "examples", "stripe", "typescript"),
      path.resolve(process.cwd(), "examples", "_harness"),
    ];
    const forbidden =
      /api\.stripe\.com|STRIPE_TEST_API_KEY|STRIPE_API_KEY|\/v1\/events|from\s+["']stripe["']|require\(["']stripe["']\)/i;
    const violations = roots
      .flatMap((root) => relativeSourceFiles(root))
      .filter(([, source]) => forbidden.test(source))
      .map(([file]) => file);
    expect(violations).toEqual([]);
  });

  it("makes the consumer harness loopback-only", () => {
    expect(() => new ConsumerClient("https://provider.invalid")).toThrow(
      "only permits loopback HTTP endpoints",
    );
    expect(() => new ConsumerClient("http://127.0.0.1:8080")).not.toThrow();
  });

  it("rejects provider URLs supplied as request paths", async () => {
    const client = new ConsumerClient("http://127.0.0.1:8080");
    await expect(client.get("https://provider.invalid/v1/customers")).rejects.toThrow(
      "only permits loopback HTTP endpoints",
    );
  });
});

function hasStaticModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) === true;
}
