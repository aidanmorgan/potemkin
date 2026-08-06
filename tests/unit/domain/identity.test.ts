import { resolveAggregateId } from '../../../src/domain/identity.js';
import { aggregateId } from '../../../src/domain/references.js';

const base = {
  targetId: null,
  path: '/orders/order-7',
  contractPath: '/orders/{id}',
  query: {},
  headers: { 'X-Order-Id': 'header-7' },
  payload: { order: { id: 'payload-7' } },
  fallback: () => 'generated-7',
};

describe('identity domain capability', () => {
  it.each([
    ['path', { from: 'path' as const, name: 'id' }, 'order-7'],
    ['header', { from: 'header' as const, name: 'x-order-id' }, 'header-7'],
    ['payload', { from: 'payload' as const, pointer: '/order/id' }, 'payload-7'],
  ])('extracts an aggregate id from %s', (_label, key, expected) => {
    expect(resolveAggregateId({ ...base, key })).toBe(expected);
  });

  it('prioritizes an explicit id, then generation, then fallback', () => {
    expect(
      resolveAggregateId({
        ...base,
        targetId: aggregateId('explicit-7'),
        generated: () => 'generated',
      }),
    ).toBe('explicit-7');
    expect(resolveAggregateId({ ...base, generated: () => 'generated-7' })).toBe('generated-7');
    expect(resolveAggregateId({ ...base })).toBe('generated-7');
  });

  it('rejects empty identities instead of admitting them into runtime state', () => {
    expect(() => aggregateId(' ')).toThrow(/aggregate-id/);
    expect(() => resolveAggregateId({ ...base, generated: () => '' })).toThrow(/aggregate-id/);
    expect(() => resolveAggregateId({ ...base, fallback: () => '' })).toThrow(/aggregate-id/);
  });
});
