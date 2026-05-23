import type { BootedSystem } from './boot.js';

/**
 * Perform an ephemeral reset of the running system.
 *
 * Steps:
 *  1. Purge the EventStore.
 *  2. Purge the StateGraph.
 *  3. Copy frozenBaseline events back into the EventStore.
 *  4. Re-project each baseline event onto the StateGraph.
 *
 * The resulting state is mathematically identical to the post-boot state
 * because the frozen UUIDv7s are deterministic (epoch-anchored).
 */
export function resetSystem(sys: BootedSystem): void {
  throw new Error('NotImplemented: engine/reset.resetSystem');
}
