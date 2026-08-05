import type { DomainEvent, ExecutionResult } from '../contracts/domain.js';
import type { JsonObject } from '../contracts/value.js';
import type {
  RuntimeEventStore,
  RuntimeIdempotencyStore,
  RuntimeStateStore,
} from '../contracts/ports.js';

/** Clone at the storage boundary so callers cannot mutate committed state. */
export function cloneValue<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

/** In-memory event-store implementation used by the boot composition root. */
export function createMemoryEventStore(): RuntimeEventStore {
  const values: DomainEvent[] = [];
  return {
    append(events) {
      values.push(...events.map(cloneValue));
    },
    events(boundary, aggregateId) {
      return values
        .filter(
          (event) =>
            (boundary === undefined || event.boundary === boundary) &&
            (aggregateId === undefined || event.aggregateId === aggregateId),
        )
        .map(cloneValue);
    },
    currentSequenceVersion(aggregateId) {
      return values.reduce(
        (version, event) =>
          event.aggregateId === aggregateId ? Math.max(version, event.sequenceVersion) : version,
        0,
      );
    },
    clear() {
      values.length = 0;
    },
  };
}

/** In-memory state-store implementation used by the boot composition root. */
export function createMemoryStateStore(): RuntimeStateStore {
  const values = new Map<string, JsonObject>();
  return {
    get: (id) => {
      const value = values.get(id);
      return value === undefined ? undefined : cloneValue(value);
    },
    set: (id, value) => {
      values.set(id, cloneValue(value));
    },
    delete: (id) => {
      values.delete(id);
    },
    entries: () => [...values.entries()].map(([id, value]) => [id, cloneValue(value)] as const),
    clear: () => {
      values.clear();
    },
  };
}

/** In-memory TTL implementation; request-local clock reads never evict shared entries. */
export function createMemoryIdempotencyStore(nowMs: () => number): RuntimeIdempotencyStore {
  const values = new Map<string, { result: ExecutionResult; expires: number }>();
  return {
    get(key, at) {
      const item = values.get(key);
      if (item === undefined) return undefined;
      if (item.expires <= (at ?? nowMs())) {
        if (at !== undefined) return undefined;
        values.delete(key);
        return undefined;
      }
      return cloneValue(item.result);
    },
    set(key, result, ttlSeconds) {
      values.set(key, {
        result: cloneValue(result),
        expires: nowMs() + Math.max(1, ttlSeconds) * 1_000,
      });
    },
    clear: () => {
      values.clear();
    },
  };
}
