/**
 * Event-sourcing time-travel helpers.
 *
 * Used by Tier 4 of X-Potemkin-* control headers:
 *   - X-Potemkin-Read-At-Version: <n>  → query against state-as-of version N
 *   - X-Potemkin-Replay-Event: <event-id>  → re-emit a historic event
 *
 * These functions intentionally avoid mutating the live state graph; they
 * project a transient state from the immutable event log.
 */

import type { DomainEvent, JsonObject } from '../types.js';
import type { EventStore } from '../eventstore/store.js';
import type { BoundaryConfig } from '../dsl/types.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import type { Logger } from '../observability/logger.js';
import type { TsReducerRegistry } from './tsReducerRegistry.js';
import type { BoundaryInferenceResult } from '../dsl/schemaInference.js';
import { createStateGraph } from '../stategraph/graph.js';
import { projectEvent } from './projection.js';

/**
 * Rebuild a single entity's state by replaying its events up to (and including)
 * `maxVersion`. Returns null when the entity has no events at that version.
 *
 * The replay delegates each event to the same `projectEvent` the live engine
 * uses, and — critically — projects each event through its OWN emitting
 * boundary's reducers + computed fields (resolved via `byBoundaryName`), exactly
 * as the live UoW did when it committed the event. Using a single boundary would
 * be wrong for the split collection/by-id architecture: a `GET /leads/{id}`
 * read boundary (LeadById) owns only the delete reducer, so replaying the
 * LeadCreated/LeadContacted history through it would drop all state. The
 * `fallbackBoundary` covers any event whose boundary is not in the map.
 */
export function rebuildEntityAtVersion(
  aggregateId: string,
  maxVersion: number,
  fallbackBoundary: BoundaryConfig,
  byBoundaryName: Readonly<Record<string, BoundaryConfig>>,
  inferredSchemas: Readonly<Record<string, BoundaryInferenceResult>> | undefined,
  events: EventStore,
  cel: CelEvaluator,
  logger?: Logger,
  tsReducerRegistry?: TsReducerRegistry,
): JsonObject | null {
  const stream = events.byAggregate(aggregateId);
  if (stream.length === 0) return null;

  // Transient graph: isolated from the live state graph so replay never mutates it.
  // Seed with {} to match the live projection path (projection.ts deepClone(current ?? {})),
  // so a boundary whose reducers never write /id does not gain a phantom id field.
  const graph = createStateGraph();
  graph.set(aggregateId, {});
  let applied = 0;

  for (const evt of stream) {
    if (evt.sequenceVersion > maxVersion) break;
    const eventBoundary = byBoundaryName[evt.boundary] ?? fallbackBoundary;
    const inferred = inferredSchemas?.[evt.boundary];
    const hasComputed = inferred !== undefined && inferred.computedOrder.length > 0;
    projectEvent({
      event: evt,
      boundary: eventBoundary,
      graph,
      cel,
      logger,
      tsReducerRegistry,
      ...(hasComputed
        ? { computed: eventBoundary.state?.computed ?? [], computedOrder: inferred.computedOrder }
        : {}),
    });
    applied++;
  }

  if (applied === 0) return null;
  return graph.get(aggregateId);
}

/** Look up an event by id in the event store; returns null if not found. */
export function findEventById(
  eventId: string,
  events: EventStore,
): DomainEvent | null {
  for (const e of events.all()) {
    if (e.eventId === eventId) return e;
  }
  return null;
}
