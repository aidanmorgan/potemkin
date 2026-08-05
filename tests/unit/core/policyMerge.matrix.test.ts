import { mergeRuntimePolicies } from '../../../src/core/policyMerge.js';

describe('source-independent policy merging', () => {
  it('merges repeated collection policies and coverage metadata deterministically', () => {
    const merged = mergeRuntimePolicies([
      {
        faults: [{ name: 'first' } as never],
        reactions: [{ on: 'Created', boundary: 'Order', emit: 'Updated' }],
        sagas: [{ name: 'first' } as never],
        derivedProjections: [{ name: 'first' } as never],
        webhooks: [{ name: 'first' } as never],
        coverage: {
          Order: { initialStates: ['OPEN'], operations: ['create'], suppressStates: [] },
        },
      },
      {
        faults: [{ name: 'second' } as never],
        reactions: [{ on: 'Updated', boundary: 'Order', emit: 'Audited' }],
        sagas: [{ name: 'second' } as never],
        derivedProjections: [{ name: 'second' } as never],
        webhooks: [{ name: 'second' } as never],
        coverage: {
          Order: {
            strict: true,
            initialStates: ['CLOSED'],
            terminalStates: ['CLOSED'],
            operations: ['update'],
            suppressStates: ['ARCHIVED'],
          },
          Payment: { terminalStates: ['SETTLED'] },
        },
      },
    ]);

    expect(merged.faults).toHaveLength(2);
    expect(merged.reactions).toHaveLength(2);
    expect(merged.sagas).toHaveLength(2);
    expect(merged.derivedProjections).toHaveLength(2);
    expect(merged.webhooks).toHaveLength(2);
    expect(merged.coverage).toEqual({
      Order: {
        strict: true,
        initialStates: ['CLOSED', 'OPEN'],
        terminalStates: ['CLOSED'],
        operations: ['create', 'update'],
        suppressStates: ['ARCHIVED'],
      },
      Payment: { terminalStates: ['SETTLED'] },
    });
  });

  it('omits optional collection and coverage outputs when no policy supplies them', () => {
    const merged = mergeRuntimePolicies([{}, { auth: { mode: 'simple' } }]);

    expect(merged).toMatchObject({
      faults: [],
      reactions: [],
      sagas: [],
      derivedProjections: [],
      webhooks: [],
      auth: { mode: 'simple' },
    });
    expect(merged.coverage).toBeUndefined();
  });
});
