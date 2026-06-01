// Response-mutation pipeline (HATEOAS, Deprecation/Sunset, field masking).
//
// Given a successful contract-path response body, this computes:
//   - HATEOAS `_links` (from boundary.hateoas, else the OpenAPI `links:` defaults),
//   - a field mask (boundary.mask + the X-Potemkin-Mask-Fields control header),
//   - deprecation/sunset/successor HEADERS (boundary.deprecated, else OpenAPI
//     `deprecated: true`),
// applies the body mutations via the single canonical applier (src/dsl/patches.ts)
// tagged by source, and returns the mutated body, the headers to set, and the
// full patch journal (used for the /_engine/forward `_patches` envelope).

import type { JsonValue, JsonObject } from '../types.js';
import type { BoundaryConfig, DeprecationConfig as BoundaryDeprecation } from '../dsl/types.js';
import type { OpenApiDoc, OpenApiOperation } from '../contract/loader.js';
import { applyPatches, type JournalEntry } from '../dsl/patches.js';
import {
  compileResponseHateoas,
  compileResponseMask,
  compileResponseDeprecation,
} from '../dsl/responseDslCompiler.js';
import {
  extractDefaultHateoas,
  extractDefaultDeprecation,
  type OperationLookup,
} from '../dsl/openapiResponseDefaults.js';

export interface ResponseMutationInput {
  readonly body: JsonValue;
  readonly boundary: BoundaryConfig;
  readonly operation: OpenApiOperation | undefined;
  readonly statusCode: number;
  readonly operationLookup: OperationLookup;
}

export interface ResponseMutationResult {
  readonly body: JsonValue;
  readonly headers: Record<string, string>;
  readonly journal: readonly JournalEntry[];
}

/** Build an operationId → path-template lookup from the OpenAPI document. */
export function buildOperationLookup(openapi: OpenApiDoc): OperationLookup {
  const byId = new Map<string, string>();
  for (const [path, item] of Object.entries(openapi.paths)) {
    for (const op of Object.values(item)) {
      const id = (op as OpenApiOperation | undefined)?.operationId;
      if (typeof id === 'string' && !byId.has(id)) byId.set(id, path);
    }
  }
  return { resolveOperationPath: (operationId) => byId.get(operationId) };
}

function isPlainObject(v: JsonValue): v is JsonObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Apply the per-entity body patches (HATEOAS merge, mask removes) to whatever
 * shape the response body takes: a single entity, a bare array of entities, or
 * a pagination envelope `{ items: [...] }`. Patches are applied with autoVivify
 * so a HATEOAS merge creates `_links` when absent and a mask remove is a no-op
 * when the field is absent.
 */
function mutateEntities(
  body: JsonValue,
  hateoasPatches: ReturnType<typeof compileResponseHateoas>,
  maskPatches: ReturnType<typeof compileResponseMask>,
  journal: JournalEntry[],
): JsonValue {
  const apply = (entity: JsonValue): JsonValue => {
    if (!isPlainObject(entity)) return entity;
    let next: JsonValue = entity;
    if (hateoasPatches.length > 0) {
      const r = applyPatches(next, hateoasPatches, 'hateoas', { autoVivify: true });
      next = r.newState;
      journal.push(...r.journal);
    }
    if (maskPatches.length > 0) {
      const r = applyPatches(next, maskPatches, 'mask', { autoVivify: true });
      next = r.newState;
      journal.push(...r.journal);
    }
    return next;
  };

  if (Array.isArray(body)) {
    return body.map(apply);
  }
  // Pagination envelope { items: [...] } — mutate each item, leave metadata.
  if (isPlainObject(body) && Array.isArray(body['items'])) {
    return { ...body, items: (body['items'] as JsonValue[]).map(apply) };
  }
  return apply(body);
}

/** Map the boundary deprecation envelope to the response-DSL deprecation shape. */
function toResponseDeprecation(
  dep: BoundaryDeprecation | undefined,
): { date?: string; sunset?: string; replacement?: string } | undefined {
  if (!dep) return undefined;
  return {
    ...(dep.date !== undefined ? { date: dep.date } : {}),
    ...(dep.sunset !== undefined ? { sunset: dep.sunset } : {}),
    ...(dep.replacement !== undefined ? { replacement: dep.replacement } : {}),
  };
}

/**
 * Compute and apply all response mutations. Returns the mutated body, the
 * headers to merge onto the HTTP response, and the combined patch journal.
 */
export function applyResponseMutations(input: ResponseMutationInput): ResponseMutationResult {
  const { body, boundary, operation, statusCode, operationLookup } = input;
  const journal: JournalEntry[] = [];

  // ── HATEOAS — boundary entries override the OpenAPI links: defaults. ──
  const hateoasEntries =
    boundary.hateoas && boundary.hateoas.length > 0
      ? [...boundary.hateoas]
      : extractDefaultHateoas(operation, statusCode, operationLookup);
  const hateoasPatches = compileResponseHateoas(hateoasEntries);

  // ── Mask — the DSL boundary.mask removes the named fields. (The runtime
  // X-Potemkin-Mask control header is applied separately by the gateway as a
  // "[MASKED]" REPLACEMENT, distinct from this removal.) ──
  const maskPatches = compileResponseMask(boundary.mask ?? []);

  const mutatedBody = mutateEntities(body, hateoasPatches, maskPatches, journal);

  // ── Deprecation/Sunset/Link headers — boundary overrides OpenAPI default. ──
  const headers: Record<string, string> = {};
  const deprecation =
    toResponseDeprecation(boundary.deprecated) ??
    (extractDefaultDeprecation(operation) ? {} : undefined);
  const deprecationPatches = compileResponseDeprecation(deprecation);
  if (deprecationPatches.length > 0) {
    const carrier = applyPatches({ headers: {} }, deprecationPatches, 'deprecation');
    const carrierHeaders = (carrier.newState as JsonObject)['headers'];
    if (isPlainObject(carrierHeaders as JsonValue)) {
      for (const [k, v] of Object.entries(carrierHeaders as JsonObject)) {
        headers[k] = String(v);
      }
    }
    journal.push(...carrier.journal);
  }

  return { body: mutatedBody, headers, journal };
}
