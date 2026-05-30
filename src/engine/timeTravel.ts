/**
 * Event-sourcing time-travel helpers.
 *
 * Used by Tier 4 of X-Potemkin-* control headers:
 *   - X-Potemkin-Read-At-Version: <n>  → query against state-as-of version N
 *   - X-Potemkin-Replay-Event: <event-id>  → re-emit a historic event
 *   - X-Potemkin-Snapshot-Mode: replay|cached  → force replay vs state-graph read
 *
 * These functions intentionally avoid mutating the live state graph; they
 * project a transient state from the immutable event log.
 */

import type { DomainEvent, JsonObject } from '../types.js';
import type { EventStore } from '../eventstore/store.js';
import type { BoundaryConfig } from '../dsl/types.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import type { Logger } from '../observability/logger.js';
import { deepClone, deepMerge } from '../stategraph/graph.js';
import { applyReducerPatchList } from './reducerPatches.js';

/**
 * Rebuild a single entity's state by replaying its events up to (and including)
 * `maxVersion`. Returns null when the entity has no events at that version.
 *
 * The replay uses the boundary's reducers with a minimal CEL context to mirror
 * how the projection engine would have applied events at commit time.
 */
export function rebuildEntityAtVersion(
  aggregateId: string,
  maxVersion: number,
  boundary: BoundaryConfig,
  events: EventStore,
  cel: CelEvaluator,
  logger?: Logger,
): JsonObject | null {
  const stream = events.byAggregate(aggregateId);
  if (stream.length === 0) return null;

  let state: JsonObject = { id: aggregateId };
  let applied = 0;

  for (const evt of stream) {
    if (evt.sequenceVersion > maxVersion) break;
    state = applyEventForReplay(state, evt, boundary, cel, logger);
    applied++;
  }

  if (applied === 0) return null;
  return state;
}

/**
 * Replay an event into a working state copy using the boundary's reducer rules.
 *
 * Mirrors the live projection engine (projection.ts): `System.GenericUpdateEvent`
 * deep-merges its payload, `BaselineEntityCreatedEvent` replaces state wholesale,
 * and every other event runs the matching reducers' `patches:` lists through the
 * single canonical applier (src/dsl/patches.ts) so historical state matches what
 * the engine produced at commit time.
 */
function applyEventForReplay(
  state: JsonObject,
  evt: DomainEvent,
  boundary: BoundaryConfig,
  cel: CelEvaluator,
  logger?: Logger,
): JsonObject {
  const buf: JsonObject = deepClone(state) as JsonObject;

  if (evt.type === 'System.GenericUpdateEvent') {
    return deepMerge(buf, evt.payload) as JsonObject;
  }
  if (evt.type === 'BaselineEntityCreatedEvent') {
    return deepClone(evt.payload) as JsonObject;
  }

  for (const reducer of boundary.reducers.filter(r => r.on === evt.type)) {
    if (!reducer.patches) continue;
    const celCtx: Record<string, unknown> = {
      event: evt as unknown as Record<string, unknown>,
      payload: evt.payload,
      state: buf,
    };
    try {
      applyReducerPatchList(buf, reducer.patches, cel, celCtx);
    } catch (err) {
      logger?.debug({ aggregateId: evt.aggregateId, event: evt.type, err }, 'Time-travel patch apply failed');
    }
  }

  return buf;
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
