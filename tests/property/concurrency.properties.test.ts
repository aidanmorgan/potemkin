/**
 * Property-based tests for concurrency conflict detection.
 *
 * Tests that when multiple commands target the same aggregate with the same
 * sequenceVersion, at most one succeeds and the rest fail with ConcurrencyConflictError.
 */

import * as fc from 'fast-check';
import { createEventStore } from '../../src/eventstore/store';
import { ConcurrencyConflictError } from '../../src/errors';
import type { DomainEvent } from '../../src/types';
import { makeEvent } from './_helpers/fixtures';

const RUN_COUNT = 100;
const SEED = 42;

// ---------------------------------------------------------------------------
// Simulate optimistic concurrency check (same logic as UoW step 4)
// ---------------------------------------------------------------------------

/**
 * Simulates the UoW optimistic-concurrency gate:
 * - Reads currentSequenceVersion from the store
 * - If provided sequenceVersion doesn't match, throws ConcurrencyConflictError
 * - Otherwise appends the event
 *
 * This is a simplified serialized gate — the real UoW uses a mutex.
 * Here we test the gate logic itself in isolation.
 */

interface ConflictTestResult {
  succeeded: number;
  failed: number;
  finalVersion: number;
}

async function runConflictingAppends(
  aggregateId: string,
  suppliedVersion: number,
  parallelCount: number,
): Promise<ConflictTestResult> {
  const store = createEventStore();

  // Pre-populate to the supplied version
  const priorEvents: DomainEvent[] = [];
  for (let i = 1; i <= suppliedVersion; i++) {
    priorEvents.push(makeEvent({ aggregateId, sequenceVersion: i }));
  }
  if (priorEvents.length > 0) {
    store.append(priorEvents);
  }

  // Mutex to serialize access (mimicking UoW lock per aggregateId)
  let lockTail = Promise.resolve();

  const results = await Promise.all(
    Array.from({ length: parallelCount }, (_unused, idx) => {
      const attempt = new Promise<'success' | 'conflict'>((resolve) => {
        lockTail = lockTail.then(async () => {
          const current = store.currentSequenceVersion(aggregateId);
          if (current !== suppliedVersion) {
            resolve('conflict');
            return;
          }
          // Attempt append
          const nextSeq = current + 1;
          const evt = makeEvent({
            aggregateId,
            sequenceVersion: nextSeq,
            eventId: `00000000-0000-7000-8000-${String(idx).padStart(12, '0')}`,
          });
          try {
            store.append([evt]);
            resolve('success');
          } catch {
            resolve('conflict');
          }
        });
      });
      return attempt;
    }),
  );

  const succeeded = results.filter((r) => r === 'success').length;
  const failed = results.filter((r) => r === 'conflict').length;
  const finalVersion = store.currentSequenceVersion(aggregateId);

  return { succeeded, failed, finalVersion };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Concurrency conflict properties', () => {
  // P1: At most one of N conflicting commands succeeds
  it('at most one command succeeds when N compete for same sequenceVersion', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 8 }),
        fc.integer({ min: 0, max: 5 }),
        async (parallelCount, priorVersion) => {
          const { succeeded, failed } = await runConflictingAppends(
            'agg-conflict-test',
            priorVersion,
            parallelCount,
          );
          expect(succeeded).toBeLessThanOrEqual(1);
          expect(succeeded + failed).toBe(parallelCount);
        },
      ),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P2: Exactly one succeeds (not zero), assuming supplied version matches current
  it('exactly one command succeeds among conflicting commands', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 6 }),
        async (parallelCount) => {
          const { succeeded } = await runConflictingAppends(
            'agg-exactly-one',
            0, // start from empty
            parallelCount,
          );
          expect(succeeded).toBe(1);
        },
      ),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P3: Final sequenceVersion after conflict equals the winning command's version
  it('final sequenceVersion equals the one successful append', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 6 }),
        fc.integer({ min: 0, max: 3 }),
        async (parallelCount, priorVersion) => {
          const { succeeded, finalVersion } = await runConflictingAppends(
            'agg-final-version',
            priorVersion,
            parallelCount,
          );
          if (succeeded === 1) {
            expect(finalVersion).toBe(priorVersion + 1);
          } else {
            // No one succeeded (shouldn't happen if priorVersion matches)
            expect(finalVersion).toBe(priorVersion);
          }
        },
      ),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P4: ConcurrencyConflictError has correct error code
  it('ConcurrencyConflictError has code CONCURRENCY_CONFLICT', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        (expected, current) => {
          fc.pre(expected !== current);
          const err = new ConcurrencyConflictError(
            `mismatch: expected ${expected}, current ${current}`,
            { expected, current },
          );
          expect(err.code).toBe('CONCURRENCY_CONFLICT');
          expect(err.status).toBe(412);
          expect(err instanceof ConcurrencyConflictError).toBe(true);
        },
      ),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P5: Sequential appends never conflict (monotonic append)
  it('sequential appends to same aggregate never conflict', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        (count) => {
          const store = createEventStore();
          const aggId = 'agg-sequential';

          for (let i = 1; i <= count; i++) {
            const evt = makeEvent({ aggregateId: aggId, sequenceVersion: i });
            expect(() => store.append([evt])).not.toThrow();
          }

          expect(store.currentSequenceVersion(aggId)).toBe(count);
        },
      ),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });
});
