/**
 * Derived Projection Engine — REQ-88 through REQ-90
 *
 * After every domain event is projected to its boundary's state graph, the
 * projection engine routes the event to every subscribed derived projection.
 *
 * Derived projections have their own entries in a separate registry keyed by
 * projection name and derived entity key.  They do NOT affect the main StateGraph.
 *
 * Admin endpoint: GET /_admin/derived/:name returns the derived state map
 * as a plain JSON object.
 */

import type { DomainEvent, JsonObject, JsonValue } from '../types.js';
import type { DerivedProjectionConfig, DerivedProjectionReduceEntry } from '../dsl/types.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import type { Logger } from '../observability/logger.js';
import type { DerivedStateMap, DerivedProjectionRegistry } from './types.js';
import { CelPhase } from '../cel/phases.js';
import { deepClone } from '../stategraph/graph.js';
import { setByDotPath, getByDotPath } from '../engine/projection.js';

/**
 * Create a new empty derived projection registry.
 */
export function createDerivedProjectionRegistry(): DerivedProjectionRegistry {
  return new Map<string, DerivedStateMap>();
}

/**
 * Route a domain event to all subscribed derived projections.
 * Mutates the registry in place.
 */
export function applyEventToDerivedProjections(
  event: DomainEvent,
  projections: readonly DerivedProjectionConfig[],
  registry: DerivedProjectionRegistry,
  cel: CelEvaluator,
  logger?: Logger,
): void {
  if (!projections || projections.length === 0) return;

  for (const proj of projections) {
    if (!isSubscribed(proj, event)) continue;

    // Find reduce entry for this event type
    const reduceEntry = findReduceEntry(proj, event);
    if (!reduceEntry) continue;

    // Evaluate the key expression to determine which derived entity to update
    const celCtx: Record<string, unknown> = {
      event: event as unknown as Record<string, unknown>,
      payload: event.payload,
    };

    let derivedKey: string;
    try {
      const keyResult = cel.evaluate(proj.key, celCtx, CelPhase.Behavior);
      if (typeof keyResult !== 'string' || !keyResult) {
        logger?.warn(
          { projectionName: proj.name, eventType: event.type },
          'Derived projection key expression returned non-string — skipping',
        );
        continue;
      }
      derivedKey = keyResult;
    } catch (err) {
      logger?.warn(
        { projectionName: proj.name, eventType: event.type, err },
        'Derived projection key evaluation failed — skipping',
      );
      continue;
    }

    // Get or create the state map for this projection
    let stateMap = registry.get(proj.name);
    if (!stateMap) {
      stateMap = new Map<string, JsonObject>();
      registry.set(proj.name, stateMap);
    }

    // Get or create the current state for this derived entity
    const currentState = stateMap.get(derivedKey);
    const buf: JsonObject = deepClone(currentState ?? {}) as JsonObject;

    // Apply the reduce entry
    applyReduceEntry(buf, reduceEntry, event, cel, logger, proj.name);

    stateMap.set(derivedKey, buf);

    logger?.debug(
      { projectionName: proj.name, derivedKey, eventType: event.type },
      'Derived projection applied',
    );
  }
}

/**
 * Check whether a projection is subscribed to a given event.
 *
 * Subscribe entries may be in either:
 *  - "<BoundaryName>:<EventType>" format
 *  - "<EventType>" format (matches regardless of boundary)
 */
function isSubscribed(proj: DerivedProjectionConfig, event: DomainEvent): boolean {
  for (const sub of proj.subscribe) {
    if (sub.includes(':')) {
      const [boundary, eventType] = sub.split(':', 2);
      if (boundary === event.boundary && eventType === event.type) return true;
    } else {
      if (sub === event.type) return true;
    }
  }
  return false;
}

/**
 * Find the reduce entry for this event type.
 * The `on` field may be the full "<Boundary>:<EventType>" or just "<EventType>".
 */
function findReduceEntry(
  proj: DerivedProjectionConfig,
  event: DomainEvent,
): DerivedProjectionReduceEntry | undefined {
  for (const entry of proj.reduce) {
    if (entry.on === event.type) return entry;
    if (entry.on === `${event.boundary}:${event.type}`) return entry;
  }
  return undefined;
}

function applyReduceEntry(
  buf: JsonObject,
  entry: DerivedProjectionReduceEntry,
  event: DomainEvent,
  cel: CelEvaluator,
  logger: Logger | undefined,
  projName: string,
): void {
  const celCtx: Record<string, unknown> = {
    event: event as unknown as Record<string, unknown>,
    payload: event.payload,
    state: buf,
  };

  if (entry.assign) {
    for (const [dotPath, expr] of Object.entries(entry.assign)) {
      try {
        const value = cel.evaluate(expr, celCtx, CelPhase.Reducer) as JsonValue;
        if (value !== undefined) {
          setByDotPath(buf, dotPath, value);
        }
      } catch (err) {
        logger?.warn(
          { projName, dotPath, expr, err },
          'Derived projection assign CEL failed — skipping field',
        );
      }
    }
  }

  if (entry.append) {
    for (const [dotPath, expr] of Object.entries(entry.append)) {
      try {
        const value = cel.evaluate(expr, celCtx, CelPhase.Reducer) as JsonValue;
        if (value !== undefined) {
          const existing = getByDotPath(buf, dotPath);
          const arr: JsonValue[] = Array.isArray(existing) ? [...existing] : [];
          arr.push(value);
          setByDotPath(buf, dotPath, arr);
        }
      } catch (err) {
        logger?.warn(
          { projName, dotPath, expr, err },
          'Derived projection append CEL failed — skipping field',
        );
      }
    }
  }
}

/**
 * Get the derived state map for a named projection.
 * Returns null if the projection name is unknown.
 */
export function getDerivedProjection(
  registry: DerivedProjectionRegistry,
  name: string,
): Record<string, JsonObject> | null {
  const map = registry.get(name);
  if (!map) return null;

  const result: Record<string, JsonObject> = {};
  for (const [key, value] of map) {
    result[key] = value;
  }
  return result;
}
