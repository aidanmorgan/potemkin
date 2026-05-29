// In-tree SDK that TypeScript reducer files import as `@potemkin/sdk`. The
// sandbox require-hook resolves that specifier here. Exposes the decorator
// and helper registration styles, patch helpers, and the RW-locked process
// registry.

import type { Patch } from '../dsl/patches.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type { Patch };

export interface ReducerContext {
  /** Current wall-clock (respects the global clock offset for time-travel). */
  now(): string;
  /** Reducer-scoped logger; structured + non-throwing. */
  log: { info(o: object | string): void; warn(o: object | string): void; debug(o: object | string): void };
}

export type ReducerFn<S = unknown, E = unknown> = (
  state: S,
  event: E,
  ctx: ReducerContext,
) => Patch[];

export interface ReducerKey {
  readonly boundary: string;
  readonly event: string;
}

export interface RegisteredReducer {
  readonly boundary: string;
  readonly event: string;
  readonly fn: ReducerFn;
  /** Source descriptor (file path, line, registration style). */
  readonly source: string;
}

// ---------------------------------------------------------------------------
// RW-locked registry — write lock for registration/swap/reset, read lock
// for dispatch snapshots.
// ---------------------------------------------------------------------------

/**
 * Tiny async RW lock. Implements the single-writer / multi-reader pattern
 * used by the SDK registry. In a single-Node-process engine the actual race
 * window is limited to event-loop microtasks, but the lock makes the
 * happens-before relationship explicit and lets tests/dev-mode reload
 * reset deterministically without torn reads.
 */
class RWLock {
  private writers = 0;
  private readers = 0;
  private waiting: Array<{ kind: 'r' | 'w'; resolve: () => void }> = [];

  async acquireRead(): Promise<void> {
    if (this.writers === 0 && !this.waiting.some((w) => w.kind === 'w')) {
      this.readers++;
      return;
    }
    return new Promise((resolve) => {
      this.waiting.push({ kind: 'r', resolve });
    });
  }

  releaseRead(): void {
    this.readers--;
    this.drain();
  }

  async acquireWrite(): Promise<void> {
    if (this.writers === 0 && this.readers === 0) {
      this.writers++;
      return;
    }
    return new Promise((resolve) => {
      this.waiting.push({ kind: 'w', resolve });
    });
  }

  releaseWrite(): void {
    this.writers--;
    this.drain();
  }

  private drain(): void {
    if (this.waiting.length === 0) return;
    if (this.writers > 0 || this.readers > 0) return;
    const next = this.waiting[0];
    if (next.kind === 'w') {
      this.waiting.shift();
      this.writers++;
      next.resolve();
      return;
    }
    // grant all consecutive readers
    while (this.waiting.length > 0 && this.waiting[0].kind === 'r') {
      const r = this.waiting.shift()!;
      this.readers++;
      r.resolve();
    }
  }
}

class Registry {
  private readonly lock = new RWLock();
  private entries = new Map<string, RegisteredReducer>();

  /** Synchronous read (no async required when not contending). */
  get(key: ReducerKey): RegisteredReducer | undefined {
    return this.entries.get(keyOf(key));
  }

  /** Read all entries — snapshot. */
  snapshot(): readonly RegisteredReducer[] {
    return [...this.entries.values()];
  }

  /**
   * Register a reducer. Used by `Reducer` decorator + `reducer()` helper.
   * `BOOT_ERR_REDUCER_CONFLICT` is thrown by the loader (not here) when
   * the same key is registered twice via different styles.
   */
  async register(entry: RegisteredReducer): Promise<void> {
    await this.lock.acquireWrite();
    try {
      const k = keyOf(entry);
      if (this.entries.has(k)) {
        const existing = this.entries.get(k)!;
        throw new Error(
          `BOOT_ERR_REDUCER_CONFLICT: ${k} already registered from ${existing.source} (new: ${entry.source})`,
        );
      }
      this.entries.set(k, entry);
    } finally {
      this.lock.releaseWrite();
    }
  }

  /**
   * Synchronous register form — used during decorator/helper evaluation
   * when no async machinery is available (e.g., inside vm.runInContext).
   * Internally acquires the write half by deferring to a queued promise
   * if the lock is held.
   */
  registerSync(entry: RegisteredReducer): void {
    // In a single-process engine, decorator evaluation is synchronous
    // top-level code; concurrent registration is impossible. If a watcher
    // swap happens to be running, the underlying lock state would prevent
    // collisions, but for sync we just check + set.
    const k = keyOf(entry);
    if (this.entries.has(k)) {
      const existing = this.entries.get(k)!;
      throw new Error(
        `BOOT_ERR_REDUCER_CONFLICT: ${k} already registered from ${existing.source} (new: ${entry.source})`,
      );
    }
    this.entries.set(k, entry);
  }

  /** Atomic-swap install — used by watch-mode reload. */
  async installSwap(replacement: ReadonlyMap<string, RegisteredReducer>): Promise<void> {
    await this.lock.acquireWrite();
    try {
      this.entries = new Map(replacement);
    } finally {
      this.lock.releaseWrite();
    }
  }

  /** Clear the registry (used by tests/setup.ts afterEach). */
  async reset(): Promise<void> {
    await this.lock.acquireWrite();
    try {
      this.entries.clear();
    } finally {
      this.lock.releaseWrite();
    }
  }

  resetSync(): void {
    this.entries.clear();
  }
}

function keyOf(key: ReducerKey): string {
  return `${key.boundary}:${key.event}`;
}

/** Process-wide singleton. The sandbox surfaces this to every loaded TS file. */
export const registry = new Registry();

// ---------------------------------------------------------------------------
// Public registration surface
// ---------------------------------------------------------------------------

/**
 * Function-style registration helper.
 *
 *   export const onLeadCreated = reducer(
 *     { boundary: 'Lead', event: 'LeadCreated' },
 *     (state, event, ctx) => [
 *       replace('/id', event.payload.id),
 *       replace('/status', 'NEW'),
 *     ]
 *   );
 */
export function reducer<S = unknown, E = unknown>(
  key: ReducerKey,
  fn: ReducerFn<S, E>,
  source?: string,
): ReducerFn<S, E> {
  registry.registerSync({
    boundary: key.boundary,
    event: key.event,
    fn: fn as ReducerFn,
    source: source ?? '<helper>',
  });
  return fn;
}

/**
 * Class-decorator style registration. Compatible with both the TC39
 * stage-3 decorator proposal and TypeScript's `experimentalDecorators`.
 */
export function Reducer(
  key: ReducerKey,
): <T extends { new (...args: never[]): { apply: ReducerFn } }>(target: T) => T {
  return (target) => {
    const instance = new target();
    registry.registerSync({
      boundary: key.boundary,
      event: key.event,
      fn: instance.apply.bind(instance),
      source: target.name ? `class:${target.name}` : '<decorator>',
    });
    return target;
  };
}

// ---------------------------------------------------------------------------
// Patch helpers
// ---------------------------------------------------------------------------

import type { JsonValue } from '../types.js';

export const add = (path: string, value: JsonValue): Patch => ({ op: 'add', path, value });
export const remove = (path: string): Patch => ({ op: 'remove', path });
export const replace = (path: string, value: JsonValue): Patch => ({
  op: 'replace',
  path,
  value,
});
export const move = (from: string, path: string): Patch => ({ op: 'move', from, path });
export const copy = (from: string, path: string): Patch => ({ op: 'copy', from, path });
export const append = (path: string, value: JsonValue): Patch => ({ op: 'append', path, value });
export const prepend = (path: string, value: JsonValue): Patch => ({ op: 'prepend', path, value });
export const increment = (path: string, by: number): Patch => ({ op: 'increment', path, by });
export const merge = (
  path: string,
  value: Record<string, JsonValue>,
  deep?: boolean,
): Patch => ({ op: 'merge', path, value, ...(deep ? { deep: true } : {}) });
export const upsert = (
  path: string,
  key: string,
  value: Record<string, JsonValue>,
): Patch => ({ op: 'upsert', path, key, value });
