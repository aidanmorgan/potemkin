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
import type { DeclaredComputedField } from '../dsl/schemaInference.js';
import { createStateGraph } from '../stategraph/graph.js';
import { projectEvent } from './projection.js';

/**
 * Rebuild a single entity's state by replaying its events up to (and including)
 * `maxVersion`. Returns null when the entity has no events at that version.
 *
 * The replay delegates each event to the same `projectEvent` function used by
 * the live projection engine, so TS reducers, computed fields, and audit fields
 * are all applied identically — X-Potemkin-Read-At-Version reconstructs exactly
 * what the engine committed at that version.
 */
export function rebuildEntityAtVersion(
  aggregateId: string,
  maxVersion: number,
  boundary: BoundaryConfig,
  events: EventStore,
  cel: CelEvaluator,
  logger?: Logger,
  tsReducerRegistry?: TsReducerRegistry,
  computed?: readonly DeclaredComputedField[],
  computedOrder?: readonly string[],
): JsonObject | null {
  const stream = events.byAggregate(aggregateId);
  if (stream.length === 0) return null;

  // Transient graph: isolated from the live state graph so replay never mutates it.
  const graph = createStateGraph();
  graph.set(aggregateId, { id: aggregateId });
  let applied = 0;

  for (const evt of stream) {
    if (evt.sequenceVersion > maxVersion) break;
    projectEvent({
      event: evt,
      boundary,
      graph,
      cel,
      logger,
      tsReducerRegistry,
      computed,
      computedOrder,
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
