import { createRuntimeFaultStore } from '../../../src/core/faults';
import { faultId } from '../../../src/domain/references';
import type { RuntimeFault } from '../../../src/model/runtime';

const rule: RuntimeFault = {
  name: 'temporary-fault',
  matches: () => true,
  response: { status: 503 },
};

describe('createRuntimeFaultStore', () => {
  it('creates branded IDs and accepts them for removal', () => {
    const store = createRuntimeFaultStore(
      () => 1_000,
      () => 'fault-1',
    );

    const id = store.add(rule);

    expect(id).toBe(faultId('fault-1'));
    expect(store.list()).toEqual([expect.objectContaining({ id, rule, createdAt: 1_000 })]);
    expect(store.remove(id)).toBe(true);
    expect(store.remove(faultId('fault-1'))).toBe(false);
  });
});
