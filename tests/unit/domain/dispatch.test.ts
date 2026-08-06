import {
  matchesHeaders,
  selectBehavior,
  type DispatchCandidate,
  type DispatchRequest,
} from '../../../src/domain/dispatch.js';
import { HttpMethod, operationId } from '../../../src/domain/references.js';

describe('behavior dispatch domain capability', () => {
  it('matches operation, inbound method, and case-insensitive headers', () => {
    const behavior = {
      operationId: operationId('updateOrder'),
      method: HttpMethod.Patch,
      headers: { 'X-Mode': 'present' },
      condition: (context: { allowed: boolean }) => context.allowed,
    } satisfies DispatchCandidate<{ allowed: boolean }>;

    expect(
      selectBehavior([behavior], {
        operationId: operationId('updateOrder'),
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
      operationId: operationId('updateOrder'),
      emitWhen: [{ when: () => false }],
      requires: [{ check: () => false }],
    };
    expect(
      selectBehavior([behavior], {
        operationId: operationId('updateOrder'),
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
          { operationId: operationId('updateOrder'), condition: () => false },
          {
            operationId: operationId('updateOrder'),
            condition: () => {
              throw new Error('bad callback');
            },
          },
        ],
        {
          operationId: operationId('updateOrder'),
          method: 'PUT',
          inbound: true,
          headers: {},
          context: {},
        },
      ),
    ).toBeUndefined();
  });

  it('preserves extension HTTP methods at the raw runtime boundary', () => {
    const candidate = {
      operationId: operationId('syncOrder'),
      method: 'PROPFIND',
    } satisfies DispatchCandidate<{}, string>;
    const request: DispatchRequest<{}, string> = {
      operationId: operationId('syncOrder'),
      method: 'propfind',
      inbound: true,
      headers: {},
      context: {},
    };

    expect(selectBehavior([candidate], request)).toBe(candidate);
  });
});
