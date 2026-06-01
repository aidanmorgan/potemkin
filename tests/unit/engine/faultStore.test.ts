/**
 * Fault store — virtual-clock TTL test
 */
import { createFaultStore } from '../../../src/faults/store';
import type { FaultRule } from '../../../src/dsl/types';

const RULE: FaultRule = {
  name: 'test-fault',
  match: { condition: 'true' },
  response: { status: 503, body: { error: 'DOWN' } },
};

describe('faults/store', () => {
  it('injected nowMs: advancing virtual clock past ttlSeconds prunes the entry', () => {
    let virtualMs = 1_000_000;
    const store = createFaultStore({ nowMs: () => virtualMs });

    const id = store.add(RULE, 5); // 5 s TTL from virtual clock

    // Entry is live before TTL elapses.
    expect(store.list().map(e => e.id)).toContain(id);
    expect(store.all()).toHaveLength(1);

    // Advance virtual clock past the 5 s TTL — entry must be pruned.
    virtualMs += 6_000;

    expect(store.list()).toHaveLength(0);
    expect(store.all()).toHaveLength(0);
  });

  it('stores without nowMs default to Date.now and work normally', () => {
    const store = createFaultStore();
    const id = store.add(RULE, 60); // 60 s — well within real time
    expect(store.list().map(e => e.id)).toContain(id);
    store.remove(id);
    expect(store.list()).toHaveLength(0);
  });
});
