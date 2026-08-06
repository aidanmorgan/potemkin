import type { RuntimeFaultEntry, RuntimeFaultStore } from '../model/runtime.js';
import { faultId, type FaultId } from '../domain/references.js';

/** Per-runtime dynamic fault storage; no process-global state is shared. */
export function createRuntimeFaultStore(
  nowMs: () => number,
  uuid: () => string,
): RuntimeFaultStore {
  const entries = new Map<FaultId, RuntimeFaultEntry>();
  const prune = (at = nowMs(), evict = true): void => {
    const now = at;
    for (const [id, entry] of entries) {
      if (evict && entry.expiresAt !== undefined && entry.expiresAt <= now) entries.delete(id);
    }
  };
  return {
    add(rule, ttlMs) {
      prune();
      const id = faultId(uuid());
      const createdAt = nowMs();
      entries.set(id, {
        id,
        rule,
        createdAt,
        ...(ttlMs === undefined ? {} : { expiresAt: createdAt + Math.max(0, ttlMs) }),
      });
      return id;
    },
    remove(id) {
      return entries.delete(id);
    },
    list(at) {
      if (at === undefined) {
        prune();
        return [...entries.values()];
      }
      prune(at, false);
      return [...entries.values()].filter(
        (entry) => entry.expiresAt === undefined || entry.expiresAt > at,
      );
    },
    all(at) {
      return this.list(at).map((entry) => entry.rule);
    },
    clear() {
      entries.clear();
    },
  };
}
