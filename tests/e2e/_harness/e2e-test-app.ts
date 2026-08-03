/**
 * Combined e2e test app — boots Specmatic JVM + plugin + Node engine together
 * and exposes a clean shutdown handle.
 *
 * Usage:
 *   const app = await startE2eApp();
 *   // hit app.stubUrl for Specmatic-proxied requests
 *   // hit app.engineUrl only for control-plane/admin inspection
 *   await app.shutdown();
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import type { ChildProcess } from "node:child_process";
import * as yaml from "js-yaml";
import { ensureSpecmaticJar, ensurePluginJar } from "../../../src/conformance/binaries.js";
import { startSpecmatic } from "../../../src/conformance/specmaticProcess.js";
import { startEngine } from "./engine-driver";
import { getFreePort } from "../../../src/conformance/portAllocator.js";
import { buildSharedForwardBlocks } from "./forward-blocks";
import { loadEngineFixture, resolveFixtureDir } from "../../fixtures/index";
import type { SpecmaticHandle } from "../../../src/conformance/specmaticProcess.js";
import type { EngineHandle } from "./engine-driver";
import type { RuntimeTransportObservation } from "../../../src/model/runtime";
import type { JsonValue } from "../../../src/types";
import { createRuntimeOtelRequestResponseObserver } from "../../../src/observability/runtimeExchange";
import { createRuntimeOtelMetricObserver } from "../../../src/observability/metrics";
import { getTracer, initTracing } from "../../../src/observability/tracing";
import type { OtlpCollector, OtlpMetricExport, OtlpTraceExport } from "./otlp-collector";
import { startOtlpCollector } from "./otlp-collector";

export interface RuntimeLogObservation {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}

export interface RuntimeMetricObservation {
  readonly name: string;
  readonly value?: number;
  readonly fields?: Readonly<Record<string, string>>;
}

const E2E_FIXTURES = [
  "crm",
  "audit-fields",
  "authoring-parity",
  "composition",
  "configured-stack",
  "crm-forward",
  "crm-jwt",
  "crm-session",
  "crm-versioned",
  "governance",
  "header-match",
  "identity-key",
  "latency",
  "mask-fields",
  "reactions",
  "reducer-ops",
  "saga-comp",
  "seeds-engine",
  "strict-schema",
  "webhook-hmac",
  "observability",
  "session-parity",
  "query-policy",
  "validation-controls",
] as const;

/**
 * Resolve the OpenAPI contract served by the Specmatic stub for a given
 * fixture. The stub validates requests/responses against this contract, so it
 * MUST match the OpenAPI the engine booted with. Falls back to the CRM contract
 * when no fixture is supplied or the fixture has no openapi/ directory.
 */
function resolveContractPath(fixtureName: string | undefined): string {
  const name = fixtureName ?? "crm";
  const fixtureDir = resolveFixtureDir(name);
  const openapiDir = path.join(fixtureDir, "openapi");
  if (!fs.existsSync(openapiDir))
    return path.join(resolveFixtureDir("crm"), "openapi", "nuisance-bureau.yaml");
  const files = fs.readdirSync(openapiDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  const fullContract = files.find((file) => file === "specmatic-contract.yaml");
  if (fullContract !== undefined) return path.join(openapiDir, fullContract);
  if (!fixtureName) return path.join(resolveFixtureDir("crm"), "openapi", "nuisance-bureau.yaml");
  if (files.length === 0)
    return path.join(resolveFixtureDir("crm"), "openapi", "nuisance-bureau.yaml");
  const preferred = files.find((f) => f === "nuisance-bureau.yaml") ?? files[0];
  return path.join(openapiDir, preferred);
}

function resolveAllContractPaths(): string[] {
  const unique = new Map<string, string>();
  for (const fixtureName of E2E_FIXTURES) {
    const openapiDir = path.join(resolveFixtureDir(fixtureName), "openapi");
    if (!fs.existsSync(openapiDir)) continue;
    const files = fs
      .readdirSync(openapiDir)
      .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"));
    const selected = files.includes("specmatic-contract.yaml")
      ? ["specmatic-contract.yaml"]
      : files.filter((file) => !file.startsWith("part-"));
    for (const file of selected) {
      const absolute = path.resolve(openapiDir, file);
      try {
        unique.set(fs.realpathSync(absolute), absolute);
      } catch {
        unique.set(absolute, absolute);
      }
    }
  }
  return [...unique.values()].sort();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface E2eApp {
  readonly specmatic: SpecmaticHandle;
  readonly engine: EngineHandle;
  /** http://127.0.0.1:<specmatic-port> — send test requests here */
  readonly stubUrl: string;
  /** http://127.0.0.1:<engine-port> — direct Node engine access */
  readonly engineUrl: string;
  /** http://127.0.0.1:<plugin-control-port> — plugin's control server */
  readonly pluginControlUrl: string;
  /** The single potemkin.yml currently monitored by the shared Node engine. */
  readonly configurationPath: string;
  /** True when a known engine-owned request was forwarded through Specmatic. */
  readonly stubForwardingHealthy: boolean;
  /** Test-owned final transport observations emitted by the canonical gateway. */
  readonly transportObservations: RuntimeTransportObservation[];
  /** Test-owned runtime log records emitted by the injected observability port. */
  readonly logObservations: RuntimeLogObservation[];
  /** Test-owned runtime metric records emitted by the injected observability port. */
  readonly metricObservations: RuntimeMetricObservation[];
  /** OTLP trace exports emitted by the real production tracing exporter. */
  readonly otelTraceExports: OtlpTraceExport[];
  /** OTLP metric exports emitted by the real production metrics exporter. */
  readonly otelMetricExports: OtlpMetricExport[];
  shutdown(): Promise<void>;
}

export interface E2eAppOptions {
  specmaticPort?: number;
  enginePort?: number;
  pluginControlPort?: number;
  /** Optional fixture name (e.g. "crm-jwt", "crm-session", "crm-versioned"). */
  fixtureName?: string;
  /** Optional arbitrary potemkin.yml for configured-source matrix tests. */
  potemkinConfigPath?: string;
  /** Custom engine-owned probe used to prove forwarding after a reload. */
  warmupPath?: string;
  warmupExpectedStatus?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Probe until the given URL responds with any HTTP status. */
async function probeUrl(targetUrl: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get(targetUrl, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => resolve(false));
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 300));
  }

  return false;
}

// Shared JWT secret for the crm-jwt / crm-forward fixtures (auth.mode: jwt).
// Kept in sync with tests/fixtures/crm-jwt/dsl/global.yaml — used only to mint a
// warmup token so the discovery probe can reach the engine past JWT auth.
const WARMUP_JWT_SECRET = "potemkin-jwt-e2e-test-secret-do-not-use";
const WARMUP_JWT_ISSUER = "potemkin-test";
const WARMUP_JWT_AUDIENCE = "potemkin-api";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** Mint an HS256 JWT valid for the crm-jwt/crm-forward fixtures. */
function mintWarmupJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8"));
  const payload = base64url(
    Buffer.from(
      JSON.stringify({
        sub: "warmup",
        scopes: "manager admin",
        iss: WARMUP_JWT_ISSUER,
        aud: WARMUP_JWT_AUDIENCE,
        iat: now,
        exp: now + 3600,
      }),
      "utf8",
    ),
  );
  const signingInput = `${header}.${payload}`;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHmac } = require("node:crypto");
  const sig = base64url(createHmac("sha256", WARMUP_JWT_SECRET).update(signingInput).digest());
  return `${signingInput}.${sig}`;
}

/**
 * An owned single-entity GET on a KNOWN-ABSENT id per fixture — used to warm
 * discovery AND to prove the response came from the engine rather than from
 * Specmatic's generator.
 *
 * Why a bogus id: a well-formed GET /leads/{uuid} satisfies the OpenAPI
 * contract, so when the plugin is NOT forwarding, Specmatic generates a happy
 * 2xx example for it. The ENGINE, in contrast, returns a deterministic
 * entity-absence response for an id it does not hold (404 for query boundaries;
 * 404/422 on a bogus id is something ONLY the engine produces
 * — a Specmatic-generated response for the same request would be a 2xx example.
 *
 * For JWT-auth fixtures (crm-jwt, crm-forward) the probe carries a valid bearer
 * token so it reaches the engine's entity-absence path rather than the auth
 * 401 (which would be ambiguous against operations that declare a 401 response).
 */
function warmupProbeForFixture(fixtureName: string | undefined): {
  path: string;
  engineStatuses: readonly number[];
  headers: Record<string, string>;
} {
  // A syntactically valid UUID that no fixture seeds, so the engine never holds
  // an entity for it.
  const BOGUS_ID = "00000000-0000-7000-8000-0000deadbeef";
  const accept: Record<string, string> = { Accept: "application/json" };
  switch (fixtureName) {
    case "governance":
      return { path: `/documents/${BOGUS_ID}`, engineStatuses: [404, 422], headers: accept };
    case "composition":
      return { path: `/documents/${BOGUS_ID}`, engineStatuses: [404, 422], headers: accept };
    case "reducer-ops":
      return { path: `/items/${BOGUS_ID}`, engineStatuses: [404, 422], headers: accept };
    case "identity-key":
      return { path: `/tokens/${BOGUS_ID}`, engineStatuses: [404, 422], headers: accept };
    case "header-match":
      return { path: `/orders/${BOGUS_ID}`, engineStatuses: [404, 422], headers: accept };
    case "saga-comp":
      return { path: `/orders/${BOGUS_ID}`, engineStatuses: [404, 422], headers: accept };
    case "webhook-hmac":
      return { path: `/shipments/${BOGUS_ID}`, engineStatuses: [404, 422], headers: accept };
    case "latency":
      return { path: `/jobs/${BOGUS_ID}`, engineStatuses: [404, 422], headers: accept };
    case "reactions":
      return { path: `/orders/${BOGUS_ID}`, engineStatuses: [404, 422], headers: accept };
    case "strict-schema":
      return { path: `/order-items/${BOGUS_ID}`, engineStatuses: [404, 422], headers: accept };
    case "seeds-engine":
      return { path: `/widgets/${BOGUS_ID}`, engineStatuses: [404, 422], headers: accept };
    case "mask-fields":
      return { path: `/reports/${BOGUS_ID}`, engineStatuses: [404, 422], headers: accept };
    case "audit-fields":
      return { path: `/notes/${BOGUS_ID}`, engineStatuses: [404, 422], headers: accept };
    case "crm-jwt":
    case "crm-forward":
      return {
        path: `/leads/${BOGUS_ID}`,
        engineStatuses: [404],
        headers: { ...accept, authorization: `Bearer ${mintWarmupJwt()}` },
      };
    default:
      return { path: `/leads/${BOGUS_ID}`, engineStatuses: [404], headers: accept };
  }
}

/**
 * Poll an owned single-entity GET path through the stub until the plugin
 * forwards it to the ENGINE — proven by an engine-specific status (entity
 * absence / unhandled query) on a known-absent id, NOT merely any numeric
 * status. A 2xx here means Specmatic generated the response itself (forwarding
 * is not yet healthy); a status 0 / parse error means the route is not yet
 * discovered. Only the engine-specific status proves a real forwarded response.
 */
async function warmStubForwarding(
  stubUrl: string,
  fixtureName: string | undefined,
  customProbe?: {
    readonly path: string;
    readonly engineStatuses: readonly number[];
    readonly headers: Record<string, string>;
  },
): Promise<boolean> {
  const { path: p, engineStatuses, headers } = customProbe ?? warmupProbeForFixture(fixtureName);
  // Healthy forwarding converges within a second or two; cap the wait so a
  // broken plugin/engine connection fails startup promptly.
  const deadline = Date.now() + 6_000;
  let consecutiveHealthy = 0;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${stubUrl}${p}`, {
        method: "GET",
        headers: { connection: "close", ...headers },
      });
      // Drain the response before starting the next request. Cancelling the
      // body here can leave Specmatic closing the same socket while the next
      // suite's first request is already being accepted by the JVM, which
      // manifests as a transient ECONNRESET on the shared session.
      await res.arrayBuffer();
      // Only an engine-specific status proves the engine served this response.
      // A 2xx is a Specmatic-generated example (not forwarding); 0/parse error
      // means the route is not yet discovered.
      if (engineStatuses.includes(res.status)) {
        consecutiveHealthy += 1;
        if (consecutiveHealthy >= 3) return true;
      } else {
        consecutiveHealthy = 0;
      }
    } catch {
      // fetch failed (e.g. status 0 / HTTPParserError) — not forwarding yet.
      consecutiveHealthy = 0;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

interface SharedE2eSession {
  readonly specmatic: SpecmaticHandle;
  readonly engine: EngineHandle;
  readonly configPath: string;
  readonly logObservationPath: string;
  readonly metricObservationPath: string;
  readonly otelTracePath: string;
  readonly otelMetricPath: string;
  readonly overlayFilePath?: string;
  readonly stubUrl: string;
  readonly engineUrl: string;
  readonly pluginControlUrl: string;
  readonly transportObservations: RuntimeTransportObservation[];
  readonly logObservations: RuntimeLogObservation[];
  readonly metricObservations: RuntimeMetricObservation[];
  readonly otelTraceExports: OtlpTraceExport[];
  readonly otelMetricExports: OtlpMetricExport[];
  readonly otlpCollector?: OtlpCollector;
  readonly tracingShutdown?: () => Promise<void>;
  readonly owner: boolean;
  reload(input: E2eReloadInput): Promise<boolean>;
  shutdown(): Promise<void>;
}

interface E2eReloadInput {
  readonly configPath: string;
  readonly fixtureName?: string;
  readonly warmupPath?: string;
  readonly warmupExpectedStatus?: number;
}

interface E2eProcessState {
  sharedSession?: Promise<SharedE2eSession>;
}

interface E2eRegistry {
  readonly ownerPid: number;
  readonly jvmPid: number;
  readonly stubPort: number;
  readonly enginePort: number;
  readonly pluginControlPort: number;
  readonly configPath: string;
  readonly observationPath: string;
  readonly logObservationPath: string;
  readonly metricObservationPath: string;
  readonly otelTracePath: string;
  readonly otelMetricPath: string;
  readonly overlayFilePath?: string;
}

const E2E_REGISTRY_PATH = path.join(
  os.tmpdir(),
  `potemkin-e2e-session-${process.env["JEST_WORKER_ID"] ?? "0"}.json`,
);

function e2eProcessState(): E2eProcessState {
  const processWithState = process as typeof process & { __potemkinE2eState?: E2eProcessState };
  processWithState.__potemkinE2eState ??= {};
  return processWithState.__potemkinE2eState;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function absolutePatterns(patterns: unknown, cwd: string): unknown {
  return Array.isArray(patterns)
    ? patterns.map((pattern) =>
        typeof pattern === "string" ? path.resolve(cwd, pattern) : pattern,
      )
    : patterns;
}

function normalizedConfiguration(
  sourcePath: string,
  enginePort: number,
  pluginControlPort: number,
  fallbackContractPath: string,
  sharedForwardConfig: Record<string, unknown>,
): string {
  const sourceDir = path.dirname(path.resolve(sourcePath));
  const root = asRecord(yaml.load(fs.readFileSync(sourcePath, "utf8")));
  root["specmatic"] = path.resolve(sourceDir, String(root["specmatic"] ?? "specmatic.yaml"));
  root["modules"] = absolutePatterns(root["modules"], sourceDir);
  root["openapi"] = absolutePatterns(root["openapi"] ?? [fallbackContractPath], sourceDir);
  const typescript = asRecord(root["typescript"]);
  const scan = Array.isArray(typescript["scan"])
    ? typescript["scan"].map((entry) => {
        const item = asRecord(entry);
        return {
          ...item,
          include: absolutePatterns(item["include"], sourceDir),
          ...(item["exclude"] === undefined
            ? {}
            : { exclude: absolutePatterns(item["exclude"], sourceDir) }),
        };
      })
    : undefined;
  if (scan !== undefined) root["typescript"] = { ...typescript, scan };
  const plugin = asRecord(root["plugin"]);
  root["plugin"] = {
    ...plugin,
    engine: {
      ...asRecord(plugin["engine"]),
      url: `http://127.0.0.1:${enginePort}`,
      timeoutMs: 5_000,
    },
    controlPort: pluginControlPort,
  };
  Object.assign(root, sharedForwardConfig);
  return yaml.dump(root);
}

function sharedForwardConfig(pluginConfigYaml: string): Record<string, unknown> {
  return asRecord(yaml.load(pluginConfigYaml));
}

async function ensureEngineRunning(
  session: Omit<SharedE2eSession, "reload" | "shutdown">,
): Promise<void> {
  if (await probeUrl(`${session.engineUrl}/_engine/health`, 1_500)) return;
  await session.engine.restart(session.pluginControlUrl);
  await probeUrl(`${session.engineUrl}/_engine/health`, 15_000);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readRegistry(): E2eRegistry | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(E2E_REGISTRY_PATH, "utf8")) as E2eRegistry;
    if (!processIsAlive(parsed.ownerPid) || !processIsAlive(parsed.jvmPid)) {
      try {
        process.kill(parsed.jvmPid, "SIGTERM");
      } catch {
        /* stale process */
      }
      fs.unlinkSync(E2E_REGISTRY_PATH);
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function readTransportObservations(filePath: string): RuntimeTransportObservation[] {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(value) ? (value as RuntimeTransportObservation[]) : [];
  } catch {
    return [];
  }
}

function readSharedArray<T>(filePath: string): T[] {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}

function writeSharedArray<T>(filePath: string, values: readonly T[]): void {
  fs.writeFileSync(filePath, JSON.stringify(values), "utf8");
}

function writeConfiguration(filePath: string, contents: string): void {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, contents, "utf8");
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      /* best effort */
    }
    throw error;
  }
}

function writeTransportObservations(
  filePath: string,
  observations: readonly RuntimeTransportObservation[],
): void {
  fs.writeFileSync(filePath, JSON.stringify(observations), "utf8");
}

function sharedObservations<T>(filePath: string, owner: boolean): T[] {
  const local: T[] = [];
  let arrayOperationDepth = 0;
  const refresh = (): void => {
    if (owner) return;
    local.length = 0;
    local.push(...readSharedArray<T>(filePath));
  };
  return new Proxy(local, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (
        !owner &&
        typeof value === "function" &&
        (typeof property === "string" || typeof property === "symbol") &&
        property in Array.prototype
      ) {
        return (...args: unknown[]) => {
          refresh();
          arrayOperationDepth += 1;
          try {
            return Reflect.apply(value, target, args);
          } finally {
            arrayOperationDepth -= 1;
          }
        };
      }
      if (
        !owner &&
        arrayOperationDepth === 0 &&
        (property === "length" || (typeof property === "string" && /^\d+$/.test(property)))
      ) {
        refresh();
      }
      return value;
    },
    set(target, property, value, receiver) {
      const result = Reflect.set(target, property, value, receiver);
      if (!owner && property === "length") writeSharedArray(filePath, target);
      return result;
    },
  });
}

/**
 * Keep the assertion surface array-shaped while sharing observations between
 * Jest VMs that connect to the one owner process in the E2E registry.
 */
function sharedTransportObservations(
  filePath: string,
  owner: boolean,
): RuntimeTransportObservation[] {
  const local: RuntimeTransportObservation[] = [];
  let arrayOperationDepth = 0;
  const refresh = (): void => {
    if (owner) return;
    local.length = 0;
    local.push(...readTransportObservations(filePath));
  };
  return new Proxy(local, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (
        !owner &&
        typeof value === "function" &&
        (typeof property === "string" || typeof property === "symbol") &&
        property in Array.prototype
      ) {
        return (...args: unknown[]) => {
          refresh();
          arrayOperationDepth += 1;
          try {
            return Reflect.apply(value, target, args);
          } finally {
            arrayOperationDepth -= 1;
          }
        };
      }
      if (
        !owner &&
        arrayOperationDepth === 0 &&
        (property === "length" || (typeof property === "string" && /^\d+$/.test(property)))
      ) {
        refresh();
      }
      return value;
    },
    set(target, property, value, receiver) {
      const result = Reflect.set(target, property, value, receiver);
      if (property === "length") writeTransportObservations(filePath, target);
      return result;
    },
  });
}

function remoteSpecmatic(registry: E2eRegistry): SpecmaticHandle {
  return {
    stubPort: registry.stubPort,
    process: { pid: registry.jvmPid } as ChildProcess,
    ready: async () => undefined,
    shutdown: async () => undefined,
  };
}

function remoteEngine(registry: E2eRegistry): EngineHandle {
  return {
    port: registry.enginePort,
    get url() {
      return `http://127.0.0.1:${registry.enginePort}`;
    },
    get system(): never {
      throw new Error("The shared engine runtime is owned by the booting Jest VM");
    },
    stop: async () => undefined,
    restart: async () => undefined,
  };
}

async function connectToSharedSession(
  registry: E2eRegistry,
): Promise<SharedE2eSession | undefined> {
  const engineUrl = `http://127.0.0.1:${registry.enginePort}`;
  if (!(await probeUrl(`${engineUrl}/_engine/health`, 1_500))) return undefined;
  const forward = buildSharedForwardBlocks(E2E_FIXTURES);
  const reload = async (input: E2eReloadInput): Promise<boolean> => {
    const fixture = input.fixtureName ?? "crm";
    writeConfiguration(
      registry.configPath,
      normalizedConfiguration(
        input.configPath,
        registry.enginePort,
        registry.pluginControlPort,
        resolveContractPath(fixture),
        sharedForwardConfig(forward.pluginConfigYaml),
      ),
    );
    const response = await fetch(`${engineUrl}/_admin/force-reload`, { method: "POST" });
    if (!response.ok)
      throw new Error(
        `Configuration reload failed with HTTP ${response.status}: ${await response.text()}`,
      );
    return await warmStubForwarding(
      `http://127.0.0.1:${registry.stubPort}`,
      input.fixtureName,
      input.warmupPath === undefined
        ? undefined
        : {
            path: input.warmupPath,
            engineStatuses: [input.warmupExpectedStatus ?? 404],
            headers: { Accept: "application/json" },
          },
    );
  };
  return {
    specmatic: remoteSpecmatic(registry),
    engine: remoteEngine(registry),
    configPath: registry.configPath,
    logObservationPath: registry.logObservationPath,
    metricObservationPath: registry.metricObservationPath,
    otelTracePath: registry.otelTracePath,
    otelMetricPath: registry.otelMetricPath,
    ...(registry.overlayFilePath === undefined
      ? {}
      : { overlayFilePath: registry.overlayFilePath }),
    stubUrl: `http://127.0.0.1:${registry.stubPort}`,
    engineUrl,
    pluginControlUrl: `http://127.0.0.1:${registry.pluginControlPort}`,
    transportObservations: sharedTransportObservations(registry.observationPath, false),
    logObservations: sharedObservations<RuntimeLogObservation>(registry.logObservationPath, false),
    metricObservations: sharedObservations<RuntimeMetricObservation>(
      registry.metricObservationPath,
      false,
    ),
    otelTraceExports: sharedObservations<OtlpTraceExport>(registry.otelTracePath, false),
    otelMetricExports: sharedObservations<OtlpMetricExport>(registry.otelMetricPath, false),
    owner: false,
    reload,
    shutdown: async () => undefined,
  };
}

async function bootSharedE2eSession(): Promise<SharedE2eSession> {
  const existing = readRegistry();
  if (existing !== undefined) {
    const connected = await connectToSharedSession(existing);
    if (connected !== undefined) return connected;
  }
  const specmaticPort = await getFreePort();
  const enginePort = await getFreePort();
  const pluginControlPort = await getFreePort();
  const [specmaticJar, pluginJar, initialFixture] = await Promise.all([
    ensureSpecmaticJar("2.46.2"),
    ensurePluginJar(),
    loadEngineFixture("crm"),
  ]);
  const forward = buildSharedForwardBlocks(E2E_FIXTURES);
  const contractPaths = resolveAllContractPaths();
  const configPath = path.join(os.tmpdir(), `potemkin-e2e-${process.pid}.yaml`);
  const observationPath = path.join(os.tmpdir(), `potemkin-e2e-observations-${process.pid}.json`);
  const logObservationPath = path.join(os.tmpdir(), `potemkin-e2e-logs-${process.pid}.json`);
  const metricObservationPath = path.join(os.tmpdir(), `potemkin-e2e-metrics-${process.pid}.json`);
  const otelTracePath = path.join(os.tmpdir(), `potemkin-e2e-otel-traces-${process.pid}.json`);
  const otelMetricPath = path.join(os.tmpdir(), `potemkin-e2e-otel-metrics-${process.pid}.json`);
  const pluginControlUrl = `http://127.0.0.1:${pluginControlPort}`;
  fs.writeFileSync(
    configPath,
    normalizedConfiguration(
      initialFixture.potemkinConfigPath,
      enginePort,
      pluginControlPort,
      resolveContractPath("crm"),
      sharedForwardConfig(forward.pluginConfigYaml),
    ),
    "utf8",
  );

  const specmaticEnv: Record<string, string> = { POTEMKIN_CONFIG_PATH: configPath };
  if (forward.overlayFilePath !== undefined)
    specmaticEnv["overlayFilePath"] = forward.overlayFilePath;
  let specmatic: SpecmaticHandle | undefined;
  let engine: EngineHandle | undefined;
  const transportObservations = sharedTransportObservations(observationPath, true);
  const logObservations = sharedObservations<RuntimeLogObservation>(logObservationPath, true);
  const metricObservations = sharedObservations<RuntimeMetricObservation>(
    metricObservationPath,
    true,
  );
  const recordOtlpTraceExport = (traceExport: OtlpTraceExport): void => {
    const exports = readSharedArray<OtlpTraceExport>(otelTracePath);
    exports.push(traceExport);
    writeSharedArray(otelTracePath, exports);
  };
  const recordOtlpMetricExport = (metricExport: OtlpMetricExport): void => {
    const exports = readSharedArray<OtlpMetricExport>(otelMetricPath);
    exports.push(metricExport);
    writeSharedArray(otelMetricPath, exports);
  };
  const otlpCollector = await startOtlpCollector({
    onTraceExport: recordOtlpTraceExport,
    onMetricExport: recordOtlpMetricExport,
  });
  let tracingShutdown: (() => Promise<void>) | undefined;
  writeTransportObservations(observationPath, transportObservations);
  writeSharedArray(logObservationPath, logObservations);
  writeSharedArray(metricObservationPath, metricObservations);
  writeSharedArray(otelTracePath, []);
  writeSharedArray(otelMetricPath, []);
  const observeTransportRequestResponse = (observation: RuntimeTransportObservation): void => {
    transportObservations.push(structuredClone(observation));
    writeTransportObservations(observationPath, transportObservations);
  };
  const requestResponseCapture = {
    maxBytes: 8_192,
    redact: (_direction: "request" | "response", body: JsonValue | null) =>
      redactSensitiveBody(body),
  } as const;
  try {
    const tracing = await initTracing({
      enabled: true,
      env: {},
      otlpEndpoint: otlpCollector.url,
      serviceName: "potemkin-e2e",
      spanProcessor: "simple",
      metricExportIntervalMs: 100,
    });
    tracingShutdown = tracing.shutdown;
    const otelObserver = createRuntimeOtelRequestResponseObserver({
      tracer: getTracer("potemkin-e2e"),
      spanName: "potemkin.e2e.exchange",
    });
    const otelMetricObserver = createRuntimeOtelMetricObserver();
    const observeTransportAndExport = (observation: RuntimeTransportObservation): void => {
      observeTransportRequestResponse(observation);
      otelObserver(observation);
    };
    specmatic = await startSpecmatic({
      contractPaths,
      pluginJar,
      specmaticJar,
      stubPort: specmaticPort,
      extraEnv: specmaticEnv,
    });
    await specmatic.ready();
    const runningSpecmatic = specmatic;
    engine = await startEngine({
      port: enginePort,
      pluginControlUrl,
      potemkinConfigPath: configPath,
      openapi: initialFixture.openapi,
      onConfigurationError: (error) =>
        console.error("[potemkin watcher]", error instanceof Error ? error.message : String(error)),
      observability: {
        observeTransportRequestResponse: observeTransportAndExport,
        requestResponseCapture,
        log: (level, message, fields) => {
          logObservations.push({ level, message, fields });
          writeSharedArray(logObservationPath, logObservations);
        },
        metric: (name, value, fields) => {
          metricObservations.push({ name, value, fields });
          writeSharedArray(metricObservationPath, metricObservations);
          otelMetricObserver(name, value, fields);
        },
      },
    });
    await probeUrl(`${pluginControlUrl}/_potemkin/health`, 15_000);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const session = {
      specmatic,
      engine,
      configPath,
      logObservationPath,
      metricObservationPath,
      otelTracePath,
      otelMetricPath,
      observationPath,
      ...(forward.overlayFilePath === undefined
        ? {}
        : { overlayFilePath: forward.overlayFilePath }),
      stubUrl: `http://127.0.0.1:${specmaticPort}`,
      engineUrl: `http://127.0.0.1:${enginePort}`,
      pluginControlUrl,
      transportObservations,
      logObservations,
      metricObservations,
      otelTraceExports: otlpCollector.traces,
      otelMetricExports: otlpCollector.metrics,
      otlpCollector,
      tracingShutdown,
      owner: true,
    };
    let reloadQueue = Promise.resolve();
    const reload = async (input: E2eReloadInput): Promise<boolean> => {
      const previous = reloadQueue;
      let release!: () => void;
      reloadQueue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        await ensureEngineRunning(session);
        const fixture = input.fixtureName ?? "crm";
        writeConfiguration(
          session.configPath,
          normalizedConfiguration(
            input.configPath,
            enginePort,
            pluginControlPort,
            resolveContractPath(fixture),
            sharedForwardConfig(forward.pluginConfigYaml),
          ),
        );
        const response = await fetch(`${session.engineUrl}/_admin/force-reload`, {
          method: "POST",
        });
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Configuration reload failed with HTTP ${response.status}: ${body}`);
        }
        return await warmStubForwarding(
          session.stubUrl,
          input.fixtureName,
          input.warmupPath === undefined
            ? undefined
            : {
                path: input.warmupPath,
                engineStatuses: [input.warmupExpectedStatus ?? 404],
                headers: { Accept: "application/json" },
              },
        );
      } finally {
        release();
      }
    };
    const shutdown = async (): Promise<void> => {
      process.removeListener("exit", exitCleanup);
      await session.engine.stop().catch(() => {
        /* best effort */
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await session.specmatic.shutdown().catch(() => {
        /* best effort */
      });
      if (session.tracingShutdown !== undefined) {
        await session.tracingShutdown().catch(() => {
          /* best effort */
        });
      }
      if (session.otlpCollector !== undefined) {
        await session.otlpCollector.close().catch(() => {
          /* best effort */
        });
      }
      try {
        fs.unlinkSync(session.configPath);
      } catch {
        /* best effort */
      }
      try {
        fs.unlinkSync(observationPath);
      } catch {
        /* best effort */
      }
      try {
        fs.unlinkSync(logObservationPath);
      } catch {
        /* best effort */
      }
      try {
        fs.unlinkSync(metricObservationPath);
      } catch {
        /* best effort */
      }
      try {
        fs.unlinkSync(otelTracePath);
      } catch {
        /* best effort */
      }
      try {
        fs.unlinkSync(otelMetricPath);
      } catch {
        /* best effort */
      }
      if (session.overlayFilePath !== undefined) {
        try {
          fs.unlinkSync(session.overlayFilePath);
        } catch {
          /* best effort */
        }
      }
    };
    const shared: SharedE2eSession = { ...session, reload, shutdown };
    const exitCleanup = (): void => {
      // Jest's globalTeardown runs in a separate process. Keep the JVM from
      // becoming an orphan when the worker exits normally.
      runningSpecmatic.process.kill("SIGTERM");
      try {
        fs.unlinkSync(E2E_REGISTRY_PATH);
      } catch {
        /* best effort */
      }
    };
    process.once("exit", exitCleanup);
    const jvmPid = runningSpecmatic.process.pid;
    if (jvmPid === undefined) throw new Error("Specmatic JVM did not expose a process id");
    fs.writeFileSync(
      E2E_REGISTRY_PATH,
      JSON.stringify({
        ownerPid: process.pid,
        jvmPid,
        stubPort: specmaticPort,
        enginePort,
        pluginControlPort,
        configPath,
        observationPath,
        logObservationPath,
        metricObservationPath,
        otelTracePath,
        otelMetricPath,
        ...(forward.overlayFilePath === undefined
          ? {}
          : { overlayFilePath: forward.overlayFilePath }),
      } satisfies E2eRegistry),
      "utf8",
    );
    specmatic.process.on("exit", () => {
      try {
        fs.unlinkSync(configPath);
      } catch {
        /* best effort */
      }
      try {
        fs.unlinkSync(observationPath);
      } catch {
        /* best effort */
      }
      try {
        fs.unlinkSync(logObservationPath);
      } catch {
        /* best effort */
      }
      try {
        fs.unlinkSync(metricObservationPath);
      } catch {
        /* best effort */
      }
      try {
        fs.unlinkSync(otelTracePath);
      } catch {
        /* best effort */
      }
      try {
        fs.unlinkSync(otelMetricPath);
      } catch {
        /* best effort */
      }
      if (forward.overlayFilePath !== undefined) {
        try {
          fs.unlinkSync(forward.overlayFilePath);
        } catch {
          /* best effort */
        }
      }
    });
    return shared;
  } catch (error) {
    await engine?.stop().catch(() => {
      /* best effort */
    });
    await specmatic?.shutdown().catch(() => {
      /* best effort */
    });
    if (tracingShutdown !== undefined) {
      await tracingShutdown().catch(() => {
        /* best effort */
      });
    }
    await otlpCollector.close().catch(() => {
      /* best effort */
    });
    try {
      fs.unlinkSync(configPath);
    } catch {
      /* best effort */
    }
    try {
      fs.unlinkSync(observationPath);
    } catch {
      /* best effort */
    }
    try {
      fs.unlinkSync(otelTracePath);
    } catch {
      /* best effort */
    }
    try {
      fs.unlinkSync(otelMetricPath);
    } catch {
      /* best effort */
    }
    if (forward.overlayFilePath !== undefined) {
      try {
        fs.unlinkSync(forward.overlayFilePath);
      } catch {
        /* best effort */
      }
    }
    throw error;
  }
}

export async function startE2eApp(opts: E2eAppOptions = {}): Promise<E2eApp> {
  const state = e2eProcessState();
  state.sharedSession ??= bootSharedE2eSession();
  const session = await state.sharedSession;
  const fixtureName = opts.fixtureName;
  const sourceConfigPath =
    opts.potemkinConfigPath ?? path.join(resolveFixtureDir(fixtureName ?? "crm"), "potemkin.yml");
  const healthy = await session.reload({
    configPath: sourceConfigPath,
    ...(fixtureName === undefined ? {} : { fixtureName }),
    ...(opts.warmupPath === undefined ? {} : { warmupPath: opts.warmupPath }),
    ...(opts.warmupExpectedStatus === undefined
      ? {}
      : { warmupExpectedStatus: opts.warmupExpectedStatus }),
  });
  if (!healthy)
    throw new Error(
      `Specmatic did not forward an engine-owned route for fixture ${fixtureName ?? "crm"}`,
    );
  // The health/warmup requests can finish their transport callbacks one tick
  // after the forwarding probe resolves. Leave each suite with a quiet,
  // deterministic observation boundary.
  session.transportObservations.length = 0;
  session.logObservations.length = 0;
  session.metricObservations.length = 0;
  session.otelMetricExports.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 100));
  session.transportObservations.length = 0;
  return {
    specmatic: session.specmatic,
    engine: session.engine,
    stubUrl: session.stubUrl,
    engineUrl: session.engineUrl,
    pluginControlUrl: session.pluginControlUrl,
    transportObservations: session.transportObservations,
    configurationPath: session.configPath,
    stubForwardingHealthy: healthy,
    logObservations: session.logObservations,
    metricObservations: session.metricObservations,
    otelTraceExports: session.otelTraceExports,
    otelMetricExports: session.otelMetricExports,
    async shutdown() {
      // The JVM and engine belong to the Jest process, not an individual suite.
      // globalTeardown stops them after every suite has reused this session.
    },
  };
}

function redactSensitiveBody(body: JsonValue | null): JsonValue | null {
  if (body === null) return null;
  if (Array.isArray(body)) return body.map((value) => redactSensitiveBody(value));
  if (typeof body !== "object") return body;
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [
      key,
      ["authorization", "cardNumber", "password", "secret", "token"].includes(key)
        ? "[REDACTED]"
        : redactSensitiveBody(value),
    ]),
  );
}

export async function shutdownSharedE2eApp(): Promise<void> {
  const state = e2eProcessState();
  if (state.sharedSession === undefined) return;
  const session = await state.sharedSession.catch(() => undefined);
  state.sharedSession = undefined;
  if (session?.owner === true) await session.shutdown();
}
