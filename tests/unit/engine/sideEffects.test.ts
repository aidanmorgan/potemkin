/**
 * Unit tests for the deferred-side-effect queue used by bulk-transactional
 * batches (potemkin-1t0). The queue must hold thunks until an explicit flush,
 * discard them on abort, and never reject the flush when a thunk fails.
 */

import { createSideEffectQueue } from '../../../src/engine/sideEffects.js';

describe('SideEffectQueue', () => {
  it('does not run enqueued thunks until flush', () => {
    const q = createSideEffectQueue();
    let ran = 0;
    q.enqueue(async () => { ran += 1; });
    q.enqueue(async () => { ran += 1; });

    expect(q.size()).toBe(2);
    expect(ran).toBe(0);

    q.flush();
    expect(ran).toBe(2);
    expect(q.size()).toBe(0);
  });

  it('discard drops thunks so they never run', () => {
    const q = createSideEffectQueue();
    let ran = 0;
    q.enqueue(async () => { ran += 1; });

    q.discard();
    expect(q.size()).toBe(0);

    q.flush();
    expect(ran).toBe(0);
  });

  it('a failing thunk does not throw out of flush and does not block siblings', async () => {
    const q = createSideEffectQueue();
    let secondRan = false;
    q.enqueue(async () => { throw new Error('boom'); });
    q.enqueue(async () => { secondRan = true; });

    expect(() => q.flush()).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(secondRan).toBe(true);
  });
});
