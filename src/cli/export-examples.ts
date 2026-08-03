/**
 * Export deterministic, contract-shaped Specmatic externalized examples.
 *
 * Usage:
 *   pnpm run export:examples -- examples/crm
 *   pnpm run export:examples -- examples/crm --check
 *
 * The exporter deliberately boots the real Node engine and snapshots its
 * read path. It does not reimplement reducers or response shaping and it does
 * not require the Specmatic JVM.
 */

import * as fs from "node:fs";
import type { Server } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import request from "supertest";
import { loadOpenApi, type OpenApiDoc } from "../contract/loader.js";
import { matchRoute } from "../contract/router.js";
import { bootYamlRuntimeFromConfig } from "../parser/files.js";
import type { RuntimeSystem } from "../runtime/system.js";
import { createDeterministicRuntimeHost } from "../runtime/host.js";
import { deriveRuntimeFixtures } from "../http/runtimeFixtures.js";
import { createRuntimeGateway } from "../http/runtimeGateway.js";
import type { FixtureStub } from "../http/specmaticTransport.js";
import { ExportError } from "../errors.js";
import type { JsonValue } from "../types.js";
import { collectDeclaredErrorExamples } from "./declared-error-examples.js";
import {
  collectDeclaredExportExamples,
  collectTransitionExamples,
  type ExportRequestTarget,
} from "./transition-examples.js";

export interface ExportExample {
  readonly name: string;
  readonly httpRequest: {
    readonly method: string;
    readonly path: string;
    readonly headers?: Record<string, string>;
    readonly body?: JsonValue;
  };
  readonly httpResponse: {
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly body: JsonValue;
  };
}

export interface ExportExamplesInput {
  readonly potemkinConfigPath: string;
  readonly contractPath: string;
  readonly outputDir: string;
  /** When true, compare generated files with outputDir without changing it. */
  readonly check?: boolean;
}

export interface ExportExamplesResult {
  readonly outputDir: string;
  readonly files: readonly string[];
  readonly changed: readonly string[];
}

function isContractFile(file: string): boolean {
  return file.endsWith(".yaml") || file.endsWith(".yml") || file.endsWith(".json");
}

export function resolveExamplePaths(arg: string): {
  readonly potemkinConfigPath: string;
  readonly contractPath: string;
  readonly defaultOutputDir: string;
} {
  const abs = path.resolve(arg);
  const stat = fs.existsSync(abs) ? fs.statSync(abs) : undefined;
  const dir = stat?.isDirectory() ? abs : path.dirname(abs);
  const potemkinConfigPath = stat?.isFile() ? abs : path.join(dir, "potemkin.yml");
  if (!fs.existsSync(potemkinConfigPath)) {
    throw new Error(`No potemkin.yml found at ${potemkinConfigPath}`);
  }
  const openapiDir = path.join(dir, "openapi");
  const specs = fs.existsSync(openapiDir)
    ? fs.readdirSync(openapiDir).filter(isContractFile).sort()
    : [];
  if (specs.length === 0) throw new Error(`No OpenAPI contract in ${openapiDir}`);
  const contractPath = path.join(openapiDir, specs[0]!);
  const stem = path.basename(contractPath, path.extname(contractPath));
  return {
    potemkinConfigPath,
    contractPath,
    defaultOutputDir: path.join(openapiDir, `${stem}_examples`),
  };
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "example";
}

function fixtureExample(fixture: FixtureStub): ExportExample {
  return {
    name: `${safeName(fixture.source.boundary)}__GET__${safeName(fixture.source.aggregateId)}`,
    httpRequest: {
      method: fixture.httpRequest.method,
      path: fixture.httpRequest.path,
      ...(fixture.httpRequest.headers ? { headers: fixture.httpRequest.headers } : {}),
    },
    httpResponse: {
      status: fixture.httpResponse.status,
      headers: fixture.httpResponse.headers,
      body: fixture.httpResponse.body,
    },
  };
}

function validationDetails(boundary: string, contractPath: string, error: unknown): ExportError {
  return new ExportError(
    `Exported response failed contract validation for ${boundary} ${contractPath}`,
    {
      boundary,
      path: contractPath,
      cause: error instanceof Error ? error.message : String(error),
    },
  );
}

function validateExample(system: RuntimeSystem, example: ExportExample, boundary: string): void {
  const operationId = system.program.dependencies.contract.operationIdFor(
    example.httpRequest.path,
    example.httpRequest.method,
  );
  if (operationId === undefined) {
    throw new ExportError(
      `Exported response has no contract operation for ${boundary} ${example.httpRequest.path}`,
      { boundary, path: example.httpRequest.path },
    );
  }
  try {
    system.program.dependencies.contract.validateResponse?.(
      operationId,
      example.httpResponse.status,
      example.httpResponse.body,
    );
  } catch (error) {
    throw validationDetails(boundary, example.httpRequest.path, error);
  }
}

function stableResponseHeaders(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  allowedHeaders: ReadonlySet<string>,
): Record<string, string> {
  const volatile = new Set([
    "connection",
    "content-length",
    "date",
    "etag",
    "keep-alive",
    "transfer-encoding",
    "x-powered-by",
  ]);
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => !volatile.has(name.toLowerCase()))
      .filter(([name]) => allowedHeaders.has(name.toLowerCase()))
      .map(
        ([name, value]) =>
          [name.toLowerCase(), Array.isArray(value) ? value.join(", ") : (value ?? "")] as const,
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  ) as Record<string, string>;
}

function declaredResponseHeaders(
  system: RuntimeSystem,
  method: string,
  pathName: string,
  status: number,
): ReadonlySet<string> {
  const matched = matchRoute(system.openapi, method, pathName);
  const declared =
    matched?.operation.responseHeaders?.[String(status)] ??
    matched?.operation.responseHeaders?.default ??
    [];
  // Content-Type is a standard response header emitted for JSON bodies and is
  // accepted by Specmatic even when the OpenAPI response omits an explicit
  // header declaration. Every other header must be declared by the contract;
  // otherwise a plain Specmatic mock rejects the externalized example at load.
  return new Set(["content-type", ...declared]);
}

function contractShapeExampleHeaders(system: RuntimeSystem, example: ExportExample): ExportExample {
  return {
    ...example,
    httpResponse: {
      ...example.httpResponse,
      headers: stableResponseHeaders(
        example.httpResponse.headers,
        declaredResponseHeaders(
          system,
          example.httpRequest.method,
          example.httpRequest.path,
          example.httpResponse.status,
        ),
      ),
    },
  };
}

function hasGetOperation(openapi: OpenApiDoc, contractPath: string): boolean {
  return openapi.paths[contractPath]?.get !== undefined;
}

async function collectionExample(
  sys: RuntimeSystem,
  boundaryName: string,
  contractPath: string,
  target: ExportRequestTarget,
): Promise<ExportExample | undefined> {
  // A collection snapshot is a bare collection route. GET-by-id examples are
  // already emitted from the baseline fixture projection and must not also be labelled as a
  // collection with an unbound `{id}` path.
  if (contractPath.includes("{")) return undefined;
  if (!hasGetOperation(sys.openapi, contractPath)) return undefined;
  if (!sys.program.byBoundaryName.has(boundaryName)) return undefined;
  const response = await request(target).get(contractPath);
  const body = (response.body === undefined ? null : response.body) as JsonValue;
  return {
    name: `${safeName(boundaryName)}__collection`,
    httpRequest: { method: "GET", path: contractPath },
    httpResponse: {
      status: response.status,
      headers: response.headers,
      body,
    },
  };
}

async function startExportTarget(system: RuntimeSystem): Promise<Server> {
  const server = createRuntimeGateway(system).listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return server;
}

async function stopExportTarget(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Collect Tier-1 examples from a booted engine. */
export async function collectExportExamples(sys: RuntimeSystem): Promise<readonly ExportExample[]> {
  const target = await startExportTarget(sys);
  try {
    const examples = new Map<string, ExportExample>();
    for (const fixture of deriveRuntimeFixtures(sys)) {
      const example = fixtureExample(fixture);
      const contractExample = contractShapeExampleHeaders(sys, example);
      validateExample(sys, contractExample, fixture.source.boundary);
      examples.set(contractExample.name, contractExample);
    }

    // Preserve the first boundary for a contract path. A sub-boundary may share
    // the collection path, but collection state is scoped by its event boundary.
    const seenCollections = new Set<string>();
    for (const boundary of sys.program.boundaries) {
      if (seenCollections.has(boundary.contractPath)) continue;
      const example = await collectionExample(
        sys,
        boundary.boundary,
        boundary.contractPath,
        target,
      );
      if (!example) continue;
      const contractExample = contractShapeExampleHeaders(sys, example);
      validateExample(sys, contractExample, boundary.boundary);
      seenCollections.add(boundary.contractPath);
      examples.set(contractExample.name, contractExample);
    }

    const declaredExamples = await collectDeclaredExportExamples(sys, target);
    for (const example of declaredExamples) {
      const contractExample = contractShapeExampleHeaders(sys, example);
      validateExample(sys, contractExample, "declared export");
      examples.set(contractExample.name, contractExample);
    }

    const transitionExamples = await collectTransitionExamples(sys, target);
    for (const example of transitionExamples) {
      const contractExample = contractShapeExampleHeaders(sys, example);
      validateExample(sys, contractExample, "transition export");
      examples.set(contractExample.name, contractExample);
    }

    for (const example of await collectDeclaredErrorExamples(
      sys,
      [...declaredExamples, ...transitionExamples],
      target,
    )) {
      const contractExample = contractShapeExampleHeaders(sys, example);
      validateExample(sys, contractExample, "declared error export");
      examples.set(contractExample.name, contractExample);
    }

    return [...examples.values()].sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await stopExportTarget(target);
  }
}

function serialise(example: ExportExample): string {
  return `${JSON.stringify(
    {
      "http-request": example.httpRequest,
      "http-response": example.httpResponse,
    },
    null,
    2,
  )}\n`;
}

function fileMap(dir: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!fs.existsSync(dir)) return result;
  for (const file of fs
    .readdirSync(dir)
    .filter((item) => item.endsWith(".json"))
    .sort()) {
    result.set(
      file,
      createHash("sha256")
        .update(fs.readFileSync(path.join(dir, file)))
        .digest("hex"),
    );
  }
  return result;
}

function writeExamples(dir: string, examples: readonly ExportExample[]): readonly string[] {
  fs.mkdirSync(dir, { recursive: true });
  const wanted = new Set<string>();
  for (const example of examples) {
    const file = `${safeName(example.name)}.json`;
    wanted.add(file);
    fs.writeFileSync(path.join(dir, file), serialise(example), "utf8");
  }
  // Only remove generated JSON files. Non-JSON files (README, manifests) are
  // user-owned and remain untouched.
  for (const file of fs.readdirSync(dir).filter((item) => item.endsWith(".json"))) {
    if (!wanted.has(file)) fs.rmSync(path.join(dir, file), { force: true });
  }
  return [...wanted].sort();
}

function compareDirectories(
  expected: Map<string, string>,
  actual: Map<string, string>,
): readonly string[] {
  const names = new Set([...expected.keys(), ...actual.keys()]);
  return [...names].sort().filter((name) => expected.get(name) !== actual.get(name));
}

async function bootForExport(input: ExportExamplesInput): Promise<RuntimeSystem> {
  const openapi = await loadOpenApi(input.contractPath);
  return bootYamlRuntimeFromConfig({
    openapi,
    potemkinConfigPath: input.potemkinConfigPath,
    host: createDeterministicRuntimeHost({
      epochMs: 0,
      randomSeed: "potemkin-export",
      uuidSeedIndex: 0,
    }),
    // Exporting examples is a pure snapshot operation. Keep the runtime's
    // webhook port explicit at this composition boundary so collection never
    // reaches an external endpoint or leaves retry timers behind.
    webhooks: {
      deliver: async () => undefined,
    },
  });
}

export async function exportExamples(input: ExportExamplesInput): Promise<ExportExamplesResult> {
  const system = await bootForExport(input);
  try {
    const examples = await collectExportExamples(system);
    if (!input.check) {
      const files = writeExamples(input.outputDir, examples);
      return { outputDir: input.outputDir, files, changed: [] };
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "potemkin-examples-"));
    try {
      writeExamples(tempDir, examples);
      const changed = compareDirectories(fileMap(input.outputDir), fileMap(tempDir));
      return {
        outputDir: input.outputDir,
        files: [...fileMap(tempDir).keys()].sort(),
        changed,
      };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } finally {
    await system.dispose();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = args.find((item) => !item.startsWith("--"));
  if (!arg) {
    process.stderr.write(
      "usage: potemkin export-examples <example-dir | potemkin.yml> [--check]\n",
    );
    process.exitCode = 2;
    return;
  }
  const paths = resolveExamplePaths(arg);
  const result = await exportExamples({
    ...paths,
    outputDir: paths.defaultOutputDir,
    ...(args.includes("--check") ? { check: true } : {}),
  });
  if (result.changed.length > 0) {
    process.stderr.write(
      `✗ examples are stale (${result.changed.length} file(s)): ${result.changed.join(", ")}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `${args.includes("--check") ? "✓ examples are current" : "✓ examples exported"} (${result.files.length} file(s))\n`,
  );
}

if (typeof require !== "undefined" && require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
