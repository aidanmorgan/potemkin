/**
 * Derives the list of FixtureStubs from a BootedSystem.
 *
 * A fixture stub represents a deterministic GET-by-id snapshot of a seeded
 * (baseline) entity at boot time.  Only entities seeded via BaselineEntityCreatedEvent
 * are included — post-boot mutations are excluded by design (REQ-10/11/39).
 *
 * For each boundary that has baseline events the helper:
 *  1. Identifies the GET-by-id OpenAPI path template (e.g. /customers/{id}).
 *  2. Looks up the current entity from sys.graph (which includes any derived props).
 *  3. Optionally validates the body against the OpenAPI response schema (skip + warn on failure).
 *  4. Returns a FixtureStub in Specmatic stub format.
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { BootedSystem } from '../engine/boot.js';
import type { FixtureStub } from './types.js';
import type { JsonValue, JsonObject } from '../types.js';
import type { OpenApiDoc } from '../contract/loader.js';
import { CelPhase } from '../cel/phases.js';
import { createLogger } from '../observability/index.js';

const logger = createLogger({ name: 'forwarding.fixtures' });

// Shared AJV instance for response-schema validation
const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
addFormats(ajv);

/**
 * Check whether a given OpenAPI path template is a "get-by-id" path relative to
 * a boundary's contractPath.  A get-by-id path:
 *  - Starts with the collection contractPath (e.g. /customers).
 *  - Has exactly one additional segment which is a {param} placeholder.
 *  - e.g. /customers/{id} qualifies; /customers/{id}/loans does not.
 */
function isGetByIdPath(contractPath: string, candidatePath: string): boolean {
  if (!candidatePath.startsWith(contractPath)) return false;
  const remainder = candidatePath.slice(contractPath.length);
  // Must be exactly /{ … } — one additional path segment that is a placeholder
  return /^\/\{[^/}]+\}$/.test(remainder);
}

/**
 * For a boundary's contractPath (e.g. /customers), scan sys.openapi.paths to find
 * the path template that:
 *  - Is a "get-by-id" child path (contractPath + /{param}).
 *  - Has a GET operation defined in OpenAPI.
 *
 * Returns the path template string (e.g. /customers/{id}), or null if none found.
 * When multiple qualify (unusual), the shortest (most specific relative to the
 * collection) is preferred.
 */
function findGetByIdPathTemplate(
  openapi: OpenApiDoc,
  collectionPath: string,
): string | null {
  const candidates: string[] = [];

  for (const [pathTemplate, pathItem] of Object.entries(openapi.paths)) {
    if (!isGetByIdPath(collectionPath, pathTemplate)) continue;
    if (pathItem['get'] === undefined) continue;
    candidates.push(pathTemplate);
  }

  if (candidates.length === 0) return null;
  // Prefer the shortest (most-direct) path
  candidates.sort((a, b) => a.length - b.length);
  return candidates[0]!;
}

/**
 * Extract the param name from a path template segment like {id} → "id".
 */
function extractIdParamName(pathTemplate: string): string {
  const match = /\/\{([^/}]+)\}$/.exec(pathTemplate);
  return match ? match[1]! : 'id';
}

/**
 * Validate a body against the 200 response schema for a given path+operation.
 * Returns true if valid or if no schema is defined.
 */
function validateBodyAgainstSchema(
  openapi: OpenApiDoc,
  pathTemplate: string,
  body: JsonValue,
): boolean {
  const pathItem = openapi.paths[pathTemplate];
  if (!pathItem) return true;

  const getOp = pathItem['get'];
  if (!getOp?.responseSchemas) return true;

  const schema = getOp.responseSchemas['200'] ?? getOp.responseSchemas['default'];
  if (!schema) return true;

  const validate = ajv.compile(schema);
  return validate(body) as boolean;
}

/**
 * Apply derived properties (x-derived OpenAPI extensions) to an entity, mirroring
 * the logic in engine/query.ts so fixtures include the same computed fields as live
 * GET requests.
 */
function applyDerivedProperties(
  entity: JsonObject,
  boundaryName: string,
  openapi: OpenApiDoc,
  sys: BootedSystem,
): JsonObject {
  const raw = openapi.raw as Record<string, unknown>;
  const components = raw?.['components'] as Record<string, unknown> | undefined;
  const schemas = components?.['schemas'] as Record<string, unknown> | undefined;
  const boundarySchema = schemas?.[boundaryName] as Record<string, unknown> | undefined;

  if (!boundarySchema) return entity;

  const properties = boundarySchema['properties'] as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return entity;

  const derivedEntries: Array<[string, string]> = [];
  for (const [propName, propSchema] of Object.entries(properties)) {
    const xDerived = propSchema['x-derived'];
    if (typeof xDerived === 'string' && xDerived.trim().length > 0) {
      derivedEntries.push([propName, xDerived]);
    }
  }

  if (derivedEntries.length === 0) return entity;

  const result: JsonObject = { ...entity };
  const celCtx: Record<string, unknown> = { state: entity as Record<string, unknown> };

  for (const [propName, expr] of derivedEntries) {
    try {
      const value = sys.cel.evaluate(expr, celCtx, CelPhase.Behavior);
      result[propName] = value as JsonValue;
    } catch (err) {
      logger.warn({ propName, boundaryName, err }, 'Derived property CEL evaluation failed in fixture — setting to null');
      result[propName] = null;
    }
  }

  return result;
}

/**
 * Derive the list of FixtureStubs from a booted system.
 *
 * Sources seeded IDs exclusively from frozenBaseline events with
 * type === 'BaselineEntityCreatedEvent' so that post-boot mutations
 * never leak into the fixture list.
 */
export function deriveFixtures(sys: BootedSystem): readonly FixtureStub[] {
  const stubs: FixtureStub[] = [];

  // Group baseline events by boundary name for efficient lookup
  const baselineByBoundary = new Map<string, string[]>();
  for (const event of sys.frozenBaseline) {
    if (event.type !== 'BaselineEntityCreatedEvent') continue;
    let ids = baselineByBoundary.get(event.boundary);
    if (!ids) {
      ids = [];
      baselineByBoundary.set(event.boundary, ids);
    }
    ids.push(event.aggregateId);
  }

  for (const boundary of sys.dsl.boundaries) {
    const seededIds = baselineByBoundary.get(boundary.boundary);
    if (!seededIds || seededIds.length === 0) continue;

    // Find the GET-by-id path template for this boundary's collection path
    const getByIdTemplate = findGetByIdPathTemplate(sys.openapi, boundary.contractPath);
    if (getByIdTemplate === null) {
      logger.debug(
        { boundary: boundary.boundary, contractPath: boundary.contractPath },
        'No GET-by-id path found for boundary — skipping fixtures',
      );
      continue;
    }

    const paramName = extractIdParamName(getByIdTemplate);

    for (const aggregateId of seededIds) {
      // Retrieve current entity from state graph (post-baseline hydration state)
      const rawEntity = sys.graph.get(aggregateId);
      if (rawEntity === null) {
        logger.warn(
          { boundary: boundary.boundary, aggregateId },
          'Baseline entity not found in state graph — skipping fixture',
        );
        continue;
      }

      // Apply derived properties to match what a live GET would return
      const entity = applyDerivedProperties(rawEntity, boundary.boundary, sys.openapi, sys);

      // Build the concrete bound path, e.g. /customers/00000000-...
      const boundPath = getByIdTemplate.replace(`{${paramName}}`, aggregateId);

      // Validate against OpenAPI response schema
      if (!validateBodyAgainstSchema(sys.openapi, getByIdTemplate, entity)) {
        logger.warn(
          { boundary: boundary.boundary, aggregateId, path: boundPath },
          'Fixture body failed OpenAPI response schema validation — skipping',
        );
        continue;
      }

      stubs.push({
        httpRequest: {
          method: 'GET',
          path: boundPath,
        },
        httpResponse: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: entity,
        },
        source: {
          boundary: boundary.boundary,
          aggregateId,
          contractPath: getByIdTemplate,
        },
      });
    }
  }

  return stubs;
}
