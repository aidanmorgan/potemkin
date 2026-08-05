import { matchesHeaders, selectBehavior } from '../../../src/domain/dispatch.js';

describe('behavior dispatch domain capability', () => {
  it('matches operation, inbound method, and case-insensitive headers', () => {
    const behavior = {
      operationId: 'updateOrder',
      method: 'PATCH',
      headers: { 'X-Mode': 'present' },
      condition: (context: { allowed: boolean }) => context.allowed,
    };

    expect(
      selectBehavior([behavior], {
        operationId: 'updateOrder',
        method: 'patch',
        inbound: true,
        headers: { 'x-mode': 'fast' },
        context: { allowed: true },
      }),
    ).toBe(behavior);
    expect(matchesHeaders({ 'X-Mode': 'fast' }, { 'x-mode': 'present' })).toBe(true);
  });

  it('retains a guard-failing branch when no emit_when branch matches', () => {
    const behavior = {
      operationId: 'updateOrder',
      emitWhen: [{ when: () => false }],
      requires: [{ check: () => false }],
    };
    expect(
      selectBehavior([behavior], {
        operationId: 'updateOrder',
        method: 'PUT',
        inbound: false,
        headers: {},
        context: {},
      }),
    ).toBe(behavior);
  });

  it('skips failed conditions and malformed callback execution', () => {
    expect(
      selectBehavior(
        [
          { operationId: 'updateOrder', condition: () => false },
          {
            operationId: 'updateOrder',
            condition: () => {
              throw new Error('bad callback');
            },
          },
        ],
        { operationId: 'updateOrder', method: 'PUT', inbound: true, headers: {}, context: {} },
      ),
    ).toBeUndefined();
  });
});
