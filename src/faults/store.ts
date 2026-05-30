import type { FaultRule } from '../dsl/types.js';
import { nextUuidv7 } from '../ids/uuidv7.js';

export interface DynamicFaultEntry {
  readonly id: string;
  readonly rule: FaultRule;
  readonly createdAt: number;
  readonly expiresAt?: number;
}

export interface FaultStore {
  add(rule: FaultRule, ttlSeconds?: number): string;
  remove(id: string): boolean;
  list(): readonly DynamicFaultEntry[];
  all(): readonly FaultRule[];
  clear(): void;
}

export function createFaultStore(): FaultStore {
  const entries = new Map<string, DynamicFaultEntry>();

  function pruneExpired(): void {
    const now = Date.now();
    for (const [id, entry] of entries) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
        entries.delete(id);
      }
    }
  }

  return {
    add(rule: FaultRule, ttlSeconds?: number): string {
      pruneExpired();
      const id = nextUuidv7();
      const now = Date.now();
      entries.set(id, {
        id,
        rule,
        createdAt: now,
        ...(ttlSeconds !== undefined ? { expiresAt: now + ttlSeconds * 1000 } : {}),
      });
      return id;
    },

    remove(id: string): boolean {
      return entries.delete(id);
    },

    list(): readonly DynamicFaultEntry[] {
      pruneExpired();
      return [...entries.values()];
    },

    all(): readonly FaultRule[] {
      pruneExpired();
      return [...entries.values()].map(e => e.rule);
    },

    clear(): void {
      entries.clear();
    },
  };
}

// NOTE: there is intentionally NO module-level singleton FaultStore. A shared
// singleton would leak dynamic fault entries across booted systems and across
// concurrent requests (Specmatic dispatches in parallel). Callers that need a
// store create one via createFaultStore() and own its lifecycle. Header-driven
// faults flow through src/engine/faultSim.ts and the per-system dsl.faults
// rules, which hold no shared mutable state.
