import * as fs from 'node:fs';
import * as path from 'node:path';
import { matchRoute } from '../contract/router.js';
import type { RuntimeBoundary } from '../model/runtime.js';
import type { RuntimeSystem } from '../runtime/system.js';
import type { DomainEvent } from '../contracts/domain.js';
import { isJsonObject, isJsonValue, type JsonObject } from '../contracts/value.js';
import {
  AggregateId,
  BoundaryName,
  EventId,
  EventType,
  HttpMethod,
  SequenceVersion,
} from '../domain/references.js';
import {
  isExportedCorpusExampleInput,
  toConformanceFilePath,
  toConformanceHttpMethod,
  toConformanceRequestPath,
  toConformanceStatusCode,
  type ConformanceFilePath,
  type ExportedCorpusExample,
} from './types.js';

interface CorpusSeed {
  readonly boundary: RuntimeBoundary;
  readonly aggregateId: AggregateId;
  readonly state: JsonObject;
}

export function parseExportedCorpusExample(value: unknown): ExportedCorpusExample | undefined {
  if (!isExportedCorpusExampleInput(value)) return undefined;
  const request = value['http-request'];
  const response = value['http-response'];
  if (response.body !== undefined && !isJsonValue(response.body)) return undefined;
  try {
    return {
      request: {
        method: toConformanceHttpMethod(request.method),
        path: toConformanceRequestPath(request.path),
      },
      response: {
        status: toConformanceStatusCode(response.status),
        ...(response.body === undefined ? {} : { body: response.body }),
      },
    };
  } catch {
    return undefined;
  }
}

function readExamples(
  directory: string,
): readonly (readonly [ConformanceFilePath, ExportedCorpusExample])[] {
  const examples: Array<readonly [ConformanceFilePath, ExportedCorpusExample]> = [];
  for (const file of fs
    .readdirSync(directory)
    .filter((entry) => entry.endsWith('.json'))
    .sort()) {
    const source = toConformanceFilePath(path.join(directory, file));
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(source, 'utf8'));
    } catch (error) {
      throw new Error(`Invalid exported corpus JSON in ${source}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    const example = parseExportedCorpusExample(parsed);
    if (example === undefined) {
      throw new Error(`Malformed exported corpus example in ${source}`);
    }
    examples.push([source, example]);
  }
  return examples;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function collectionBoundaryFor(
  system: RuntimeSystem,
  contractPath: string,
): RuntimeBoundary | undefined {
  return [...system.program.boundaries]
    .filter(
      (boundary) =>
        !boundary.contractPath.includes('{') &&
        contractPath.startsWith(`${boundary.contractPath}/`),
    )
    .sort((left, right) => right.contractPath.length - left.contractPath.length)[0];
}

function seedsFrom(
  system: RuntimeSystem,
  examples: readonly (readonly [ConformanceFilePath, ExportedCorpusExample])[],
): readonly CorpusSeed[] {
  const seeds: CorpusSeed[] = [];
  for (const [, candidate] of examples) {
    const { method, path: requestPath } = candidate.request;
    const { status, body } = candidate.response;
    if (method !== HttpMethod.Get || status !== 200 || !isJsonObject(body)) continue;

    const matched = matchRoute(system.openapi, method, requestPath);
    if (matched === null || Object.keys(matched.pathParams).length === 0) continue;
    const rawAggregateId = Object.values(matched.pathParams)[0];
    const boundary = collectionBoundaryFor(system, matched.contractPath);
    if (rawAggregateId === undefined || boundary === undefined) continue;
    seeds.push({
      boundary,
      aggregateId: AggregateId.parse(rawAggregateId),
      state: body,
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
  const knownIds = new Set(baseline.state.map(([id]) => AggregateId.parse(id)));
  const events: DomainEvent[] = [...baseline.events];
  const state = [...baseline.state];
  for (const seed of seeds) {
    if (knownIds.has(seed.aggregateId)) continue;
    knownIds.add(seed.aggregateId);
    state.push([seed.aggregateId, seed.state]);
    events.push({
      eventId: EventId.parse(`corpus-${seed.boundary.boundary}-${seed.aggregateId}`),
      type: EventType.parse('BaselineEntityCreatedEvent'),
      boundary: BoundaryName.parse(seed.boundary.boundary),
      aggregateId: AggregateId.parse(seed.aggregateId),
      payload: seed.state,
      timestamp: new Date(system.clock.nowMs()).toISOString(),
      sequenceVersion: SequenceVersion.parse(1),
      causedBy: null,
    });
  }
  system.engine.restore({ state, events, projections: baseline.projections });
}
