/**
 * Coverage backfill for eventstore/store.ts
 *
 * Uncovered branches (lines 41, 44):
 *  - Line 41: !event.eventId falsy check — already covered by existing test for empty string
 *  - Line 44: !event.aggregateId falsy check — already covered
 *
 * Looking more carefully at the coverage report (87.5% branches), the uncovered branches
 * are the falsy branches of the truthy checks. Specifically the `if (aggList)` at
 * lines 77-80 covers the path where aggList already exists (already-seen aggregate).
 *
 * Actually re-reading store.ts:
 *  - Line 41: `if (!event.eventId)` — the falsy branch (event HAS an eventId → don't throw)
 *    is actually already taken by all passing tests. The TRUTHY branch (no eventId) is covered
 *    by the existing 'throws when eventId missing' test.
 *  - Line 44: `if (!event.aggregateId)` — same situation.
 *
 * The 87.5% branch coverage means 1 of 8 branches is uncovered. Looking at line 77-80:
 *  `const aggList = byAggMap.get(...)` — when aggList is undefined (new aggregate, first event)
 *  vs aggList exists (subsequent event for same aggregate). The `else` branch (set new list)
 *  handles first-time aggregates. But this is already covered by any test that creates a new store.
 *
 * The actual uncovered branch is in the `validate` function's localSeq.get path.
 * Looking at lines 41 and 44 in context:
 *  Line 41: `if (!event.eventId)` ← throw branch (truthy when missing — COVERED)
 *                                    no-throw branch (falsy when present — also COVERED by normal tests)
 *
 * The branches at lines 41 and 44 are the conditions themselves. The branch report says
 * 41 and 44 are uncovered BRANCHES not lines. This means:
 *  - Line 41 has 2 branches: [eventId truthy → skip throw] and [eventId falsy → throw].
 *    The "skip throw" branch may never be explicitly tested in isolation.
 *
 * After careful analysis, the uncovered branches at 41 and 44 are already covered by existing
 * tests. The 87.5% means 1 branch is uncovered. Looking again at the validate function,
 * the branch at line 50: `if (event.sequenceVersion !== expectedSeq)` has 2 branches:
 * match (no throw) and mismatch (throw). The "no throw" branch for sequenceVersion
 * is covered by all normal append tests.
 *
 * Let's add a test explicitly targeting the byAggMap `else` branch (aggList undefined → new entry)
 * AND the branch where an existing aggList gets pushed to (lines 77-80).
 */

import { createEventStore } from '../../../src/eventstore/store';
import { InternalExecutionError } from '../../../src/errors';
import type { DomainEvent } from '../../../src/types';

function makeEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    eventId: 'evt-coverage-1',
    boundary: 'B',
    aggregateId: 'agg-coverage-1',
    type: 'CoverageEvent',
    payload: {},
    timestamp: '2024-01-01T00:00:00.000Z',
    sequenceVersion: 1,
    causedBy: 'cmd-1',
    ...overrides,
  };
}

describe('eventstore/store — additional branch coverage', () => {

  // ── Lines 41/44: null/undefined eventId/aggregateId (??null branch) ─────────

  it('InternalExecutionError detail uses null for undefined eventId (line 41 null-branch)', () => {
    const store = createEventStore();
    // eventId: undefined → !undefined is truthy → throws; eventId ?? null = null
    try {
      store.append([makeEvent({ eventId: undefined as any, sequenceVersion: 1 })]);
      fail('expected InternalExecutionError');
    } catch (err) {
      expect(err).toBeInstanceOf(InternalExecutionError);
      const detail = (err as InternalExecutionError).details as Record<string, unknown>;
      // eventId ?? null where eventId is undefined → detail.eventId should be null
      expect(detail?.['eventId']).toBeNull();
    }
  });

  it('InternalExecutionError detail uses null for undefined aggregateId (line 44 null-branch)', () => {
    const store = createEventStore();
    // aggregateId: undefined → throws; aggregateId ?? null = null
    try {
      store.append([makeEvent({ aggregateId: undefined as any, sequenceVersion: 1 })]);
      fail('expected InternalExecutionError');
    } catch (err) {
      expect(err).toBeInstanceOf(InternalExecutionError);
      const detail = (err as InternalExecutionError).details as Record<string, unknown>;
      expect(detail?.['aggregateId']).toBeNull();
    }
  });

  // ── byAggMap new-aggregate branch (first event for aggregate) ────────────────

  it('creates new aggregate entry in byAggMap on first event', () => {
    const store = createEventStore();
    store.append([makeEvent({ eventId: 'e1', aggregateId: 'brand-new-agg', sequenceVersion: 1 })]);
    const events = store.byAggregate('brand-new-agg');
    expect(events).toHaveLength(1);
    expect(events[0]?.eventId).toBe('e1');
  });

  // ── byAggMap existing-aggregate branch (subsequent event, aggList truthy) ────

  it('pushes to existing aggList for subsequent event on same aggregate', () => {
    const store = createEventStore();
    // First event → creates the aggList entry
    store.append([makeEvent({ eventId: 'e1', sequenceVersion: 1 })]);
    // Second event → aggList already exists, pushes to it (the aggList truthy branch)
    store.append([makeEvent({ eventId: 'e2', sequenceVersion: 2 })]);

    const events = store.byAggregate('agg-coverage-1');
    expect(events).toHaveLength(2);
    expect(events[0]?.eventId).toBe('e1');
    expect(events[1]?.eventId).toBe('e2');
  });

  // ── validate: non-monotonic sequence for brand-new aggregate ─────────────────

  it('throws InternalExecutionError for first event with sequenceVersion != 1', () => {
    const store = createEventStore();
    // For a new aggregate, expectedSeq is 0+1=1. Sending seq=3 → non-monotonic
    expect(() =>
      store.append([makeEvent({ eventId: 'e1', aggregateId: 'new-agg', sequenceVersion: 3 })]),
    ).toThrow(InternalExecutionError);
  });

  it('non-monotonic error includes aggregate and expected/got values', () => {
    const store = createEventStore();
    try {
      store.append([makeEvent({ eventId: 'e1', aggregateId: 'x', sequenceVersion: 5 })]);
      fail('expected InternalExecutionError');
    } catch (err) {
      expect(err).toBeInstanceOf(InternalExecutionError);
      const detail = (err as InternalExecutionError).details as Record<string, unknown>;
      expect(detail?.['aggregateId']).toBe('x');
      expect(detail?.['expected']).toBe(1);
      expect(detail?.['got']).toBe(5);
    }
  });

  // ── validate: batch processing accumulates local sequence state ───────────────

  it('validates a multi-event batch for same aggregate sequentially in localSeq', () => {
    const store = createEventStore();
    // Batch of 3 events for same aggregate, each incrementing by 1
    expect(() =>
      store.append([
        makeEvent({ eventId: 'e1', aggregateId: 'multi', sequenceVersion: 1 }),
        makeEvent({ eventId: 'e2', aggregateId: 'multi', sequenceVersion: 2 }),
        makeEvent({ eventId: 'e3', aggregateId: 'multi', sequenceVersion: 3 }),
      ]),
    ).not.toThrow();

    expect(store.size()).toBe(3);
    expect(store.currentSequenceVersion('multi')).toBe(3);
  });

  it('validate uses localSeq accumulated from prior events in same batch', () => {
    const store = createEventStore();
    // Second event in batch for same aggregate must account for first event in same batch
    // If first = seq 1 → localSeq becomes 1, second must be 2
    expect(() =>
      store.append([
        makeEvent({ eventId: 'e1', aggregateId: 'accum', sequenceVersion: 1 }),
        makeEvent({ eventId: 'e2', aggregateId: 'accum', sequenceVersion: 3 }), // skip 2 → fail
      ]),
    ).toThrow(InternalExecutionError);
  });
});
