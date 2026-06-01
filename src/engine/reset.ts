import type { BootedSystem } from './boot.js';
import type { DomainEvent, JsonObject } from '../types.js';
import { projectEvent } from './projection.js';
import { childLogger } from '../observability/logger.js';
import { applyEventToDerivedProjections } from '../projections/engine.js';

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
 *
 * Volatile only — no disk I/O at any point (req 40).
 */
export function resetSystem(sys: BootedSystem): void {
  const resetLog = childLogger(sys.logger, { phase: 'reset' });

  // Wrap in a span — withSpan is async but we need sync; use startActiveSpan directly
  const span = sys.tracer.startActiveSpan('engine.reset', (span) => {
    const start = Date.now();
    resetLog.info({ step: 'reset_start' }, 'Reset: starting ephemeral reset');

    try {
      // ── Step 1: Purge Event Log (req 37) ───────────────────────────────────
      sys.events.purge();
      resetLog.info({ step: 'events_purged' }, 'Reset: event store purged');

      // ── Step 2: Purge State Graph (req 38) ─────────────────────────────────
      sys.graph.purge();
      resetLog.info({ step: 'graph_purged' }, 'Reset: state graph purged');

      // ── Step 3: Re-ingest frozen baseline into EventStore ──────────────────
      // Deep-clone payloads so frozen constraints are satisfied when appending.
      const rehydratedEvents: DomainEvent[] = sys.frozenBaseline.map((ev) => ({
        ...ev,
        payload: JSON.parse(JSON.stringify(ev.payload)) as JsonObject,
      }));

      sys.events.append(rehydratedEvents);
      resetLog.info(
        { step: 'events_restored', eventCount: rehydratedEvents.length },
        'Reset: baseline events restored to event store',
      );

      // ── Step 4: Re-project each baseline event (req 39) ────────────────────
      for (const event of rehydratedEvents) {
        const boundaryConfig = sys.dsl.byBoundaryName[event.boundary];
        if (!boundaryConfig) {
          // Should never happen post-boot; surface clearly if it does
          throw new Error(
            `Reset: no boundary config found for event boundary '${event.boundary}' (eventId: ${event.eventId})`,
          );
        }

        projectEvent({
          event,
          boundary: boundaryConfig,
          graph: sys.graph,
          cel: sys.cel,
          logger: resetLog,
          schemaRegistry: sys.schemaRegistry,
        });
      }

      // ── Step 5: Reset derived projections ──────────────────────────────────
      if (sys.derivedProjections) {
        sys.derivedProjections.clear();
        if (sys.dsl.derivedProjections && sys.dsl.derivedProjections.length > 0) {
          for (const event of rehydratedEvents) {
            applyEventToDerivedProjections(
              event,
              sys.dsl.derivedProjections,
              sys.derivedProjections,
              sys.cel,
              resetLog,
            );
          }
        }
      }

      // ── Step 6: Reset idempotency store ────────────────────────────────────
      sys.idempotencyStore.clear();

      // ── Step 7: Clear dynamic fault rules ──────────────────────────────────
      // Runtime faults registered via POST /_admin/faults are ephemeral; a
      // reset returns the system to its post-boot fault-free state.
      sys.faultStore?.clear();

      // ── Step 8: Reset session store ────────────────────────────────────────
      sys.sessionStore.reset();

      // ── Step 9: Drop aggregate serialization locks ─────────────────────────
      // Reset is expected to be called quiescently (no in-flight UoW). The lock
      // map is self-cleaning per-key during normal operation, but clearing here
      // guarantees it does not retain entries across a reset.
      sys.aggregateLocks.clear();

      const durationMs = Date.now() - start;
      const entityCount = sys.graph.size();

      resetLog.info(
        { step: 'reset_complete', durationMs, entityCount, baselineEvents: rehydratedEvents.length },
        'Reset: ephemeral reset complete',
      );

      span.end();
    } catch (err) {
      span.end();
      throw err;
    }
  });

  // startActiveSpan callback is synchronous here (no async used inside)
  void span;
}
