/**
 * Property-based tests for UUIDv7 utilities.
 */

import * as fc from 'fast-check';
import { nextUuidv7, epochAnchoredUuidv7, isUuidv7 } from '../../src/ids/uuidv7';

const RUN_COUNT = 200;
const SEED = 42;

describe('uuidv7 properties', () => {
  // ---------------------------------------------------------------------------
  // P1: Every nextUuidv7() result is a valid UUIDv7
  // ---------------------------------------------------------------------------
  it('nextUuidv7 always produces a valid UUIDv7', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 999 }), (_i) => {
        const id = nextUuidv7();
        expect(isUuidv7(id)).toBe(true);
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // ---------------------------------------------------------------------------
  // P2: 1000 sequential nextUuidv7() calls are strictly time-ordered
  // (UUIDv7 first 48 bits encode ms timestamp, so sort order = insertion order)
  // ---------------------------------------------------------------------------
  it('1000 sequential nextUuidv7() calls are non-decreasing by timestamp', () => {
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) {
      ids.push(nextUuidv7());
    }

    for (let i = 1; i < ids.length; i++) {
      // Compare as strings — UUIDv7 string sort matches timestamp sort for same-millisecond IDs
      // (version nibble and variant are fixed; random bits may cause equal-ms IDs to be unordered)
      const prev = ids[i - 1]!;
      const curr = ids[i]!;
      // Extract first 48-bit timestamp (12 hex chars: first 8 + first 4 of next group)
      const prevTs = prev.slice(0, 8) + prev.slice(9, 13);
      const currTs = curr.slice(0, 8) + curr.slice(9, 13);
      expect(currTs >= prevTs).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // P3: epochAnchoredUuidv7 is deterministic — same seedIndex → same UUID
  // ---------------------------------------------------------------------------
  it('epochAnchoredUuidv7 is deterministic for same seedIndex', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), (seedIndex) => {
        const a = epochAnchoredUuidv7(seedIndex);
        const b = epochAnchoredUuidv7(seedIndex);
        expect(a).toBe(b);
        expect(isUuidv7(a)).toBe(true);
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // ---------------------------------------------------------------------------
  // P4: epochAnchoredUuidv7 produces distinct UUIDs for distinct seedIndexes
  // ---------------------------------------------------------------------------
  it('epochAnchoredUuidv7 produces distinct UUIDs for 10k distinct seedIndexes', () => {
    const N = 10_000;
    const ids = new Set<string>();
    for (let i = 0; i < N; i++) {
      ids.add(epochAnchoredUuidv7(i));
    }
    expect(ids.size).toBe(N);
  });

  // ---------------------------------------------------------------------------
  // P5: epochAnchoredUuidv7 timestamps are anchored at epoch 0
  // ---------------------------------------------------------------------------
  it('epochAnchoredUuidv7 has zero timestamp (epoch anchor)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000 }), (seedIndex) => {
        const id = epochAnchoredUuidv7(seedIndex);
        // First 12 hex chars (without hyphens) encode the 48-bit timestamp — should all be 0
        const hexNoHyphens = id.replace(/-/g, '');
        const timestampHex = hexNoHyphens.slice(0, 12);
        expect(timestampHex).toBe('000000000000');
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });
});
