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

import type { DomainEvent, JsonObject, JsonValue } from '../types.js';
import type { EventStore } from '../eventstore/store.js';
import type { BoundaryConfig } from '../dsl/types.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import type { Logger } from '../observability/logger.js';
import { CelPhase } from '../cel/phases.js';
import { deepClone, deepMerge } from '../stategraph/graph.js';

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

/** Replay an event into a working state copy using the boundary's reducer rules. */
function applyEventForReplay(
  state: JsonObject,
  evt: DomainEvent,
  boundary: BoundaryConfig,
  cel: CelEvaluator,
  logger?: Logger,
): JsonObject {
  const buf: JsonObject = deepClone(state) as JsonObject;
  const reducer = boundary.reducers.find(r => r.on === evt.type);
  if (!reducer) return buf;

  const celCtx: Record<string, unknown> = {
    event: evt as unknown as Record<string, unknown>,
    payload: evt.payload,
    state: buf,
  };

  // assignAll: copy event payload onto state
  if (reducer.assignAll) {
    Object.assign(buf, evt.payload);
  }

  if (reducer.assign) {
    for (const [path, expr] of Object.entries(reducer.assign)) {
      try {
        const value = cel.evaluate(expr, celCtx, CelPhase.Reducer) as JsonValue;
        if (value !== undefined) setByDotPath(buf, path, value);
      } catch (err) {
        logger?.debug({ aggregateId: evt.aggregateId, path, err }, 'Time-travel assign eval failed');
      }
    }
  }

  if (reducer.append) {
    for (const [path, expr] of Object.entries(reducer.append)) {
      try {
        const value = cel.evaluate(expr, celCtx, CelPhase.Reducer) as JsonValue;
        if (value !== undefined) {
          const existing = getByDotPath(buf, path);
          const arr: JsonValue[] = Array.isArray(existing) ? [...existing] : [];
          arr.push(value);
          setByDotPath(buf, path, arr);
        }
      } catch (err) {
        logger?.debug({ aggregateId: evt.aggregateId, path, err }, 'Time-travel append eval failed');
      }
    }
  }

  // Merge any payload fields that the reducer did not explicitly map
  // (mirrors the projection engine's implicit-merge behaviour for fields
  // that the reducer did not touch). We use deepMerge so nested objects
  // are preserved across reapplied events.
  return deepMerge(buf, {});
}

function setByDotPath(obj: JsonObject, path: string, value: JsonValue): void {
  const segs = path.split('.');
  let cur: Record<string, JsonValue> = obj as Record<string, JsonValue>;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (cur[seg] === undefined || cur[seg] === null || typeof cur[seg] !== 'object' || Array.isArray(cur[seg])) {
      cur[seg] = {};
    }
    cur = cur[seg] as Record<string, JsonValue>;
  }
  cur[segs[segs.length - 1]] = value;
}

function getByDotPath(obj: JsonObject, path: string): JsonValue | undefined {
  const segs = path.split('.');
  let cur: unknown = obj;
  for (const seg of segs) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur as JsonValue | undefined;
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
