import * as fs from "node:fs";
import * as path from "node:path";
import { matchRoute } from "../contract/router.js";
import type { RuntimeBoundary } from "../model/runtime.js";
import type { RuntimeSystem } from "../runtime/system.js";
import type { DomainEvent, JsonObject } from "../types.js";

interface ExportedExample {
  readonly "http-request"?: {
    readonly method?: unknown;
    readonly path?: unknown;
  };
  readonly "http-response"?: {
    readonly status?: unknown;
    readonly body?: unknown;
  };
}

interface CorpusSeed {
  readonly boundary: RuntimeBoundary;
  readonly aggregateId: string;
  readonly state: JsonObject;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
}

function readExamples(directory: string): readonly [string, ExportedExample][] {
  return fs
    .readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const source = path.join(directory, file);
      const parsed: unknown = JSON.parse(fs.readFileSync(source, "utf8"));
      return [source, isRecord(parsed) ? (parsed as ExportedExample) : {}] as const;
    });
}

function collectionBoundaryFor(
  system: RuntimeSystem,
  contractPath: string,
): RuntimeBoundary | undefined {
  return [...system.program.boundaries]
    .filter(
      (boundary) =>
        !boundary.contractPath.includes("{") &&
        contractPath.startsWith(`${boundary.contractPath}/`),
    )
    .sort((left, right) => right.contractPath.length - left.contractPath.length)[0];
}

function seedsFrom(
  system: RuntimeSystem,
  examples: readonly [string, ExportedExample][],
): readonly CorpusSeed[] {
  const seeds: CorpusSeed[] = [];
  for (const [, candidate] of examples) {
    const method = candidate["http-request"]?.method;
    const requestPath = candidate["http-request"]?.path;
    const status = candidate["http-response"]?.status;
    if (
      method !== "GET" ||
      typeof requestPath !== "string" ||
      status !== 200 ||
      !isJsonObject(candidate["http-response"]?.body)
    )
      continue;

    const matched = matchRoute(system.openapi, method, requestPath);
    if (matched === null || Object.keys(matched.pathParams).length === 0) continue;
    const aggregateId = Object.values(matched.pathParams)[0];
    const boundary = collectionBoundaryFor(system, matched.contractPath);
    if (aggregateId === undefined || boundary === undefined) continue;
    seeds.push({
      boundary,
      aggregateId,
      state: candidate["http-response"]!.body as JsonObject,
    });
  }
  return seeds;
}

/**
 * Install the exported positive read states into the live in-memory engine.
 *
 * Exported Tier-2 examples are state snapshots, not a second runtime model.
 * They are converted to the same baseline event shape used by the engine so
 * collection and by-id requests exercise the normal runtime and gateway.
 */
export function seedRuntimeFromExportedExamples(
  system: RuntimeSystem,
  examplesDirectory: string,
): void {
  if (!fs.existsSync(examplesDirectory)) return;
  const seeds = seedsFrom(system, readExamples(examplesDirectory));
  if (seeds.length === 0) return;

  const baseline = system.engine.snapshot();
  const knownIds = new Set(baseline.state.map(([id]) => id));
  const events: DomainEvent[] = [...baseline.events];
  const state = [...baseline.state];
  for (const seed of seeds) {
    if (knownIds.has(seed.aggregateId)) continue;
    knownIds.add(seed.aggregateId);
    state.push([seed.aggregateId, seed.state]);
    events.push({
      eventId: `corpus-${seed.boundary.boundary}-${seed.aggregateId}`,
      type: "BaselineEntityCreatedEvent",
      boundary: seed.boundary.boundary,
      aggregateId: seed.aggregateId,
      payload: seed.state,
      timestamp: new Date(system.clock.nowMs()).toISOString(),
      sequenceVersion: 1,
      causedBy: null,
    });
  }
  system.engine.restore({ state, events, projections: baseline.projections });
}
