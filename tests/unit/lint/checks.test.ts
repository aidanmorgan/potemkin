import { coverageCheck } from '../../../src/lint/checks/coverage';
import { identityCheck } from '../../../src/lint/checks/identity';
import type { LintContext } from '../../../src/lint/types';

function ctx(partial: { boundaries?: unknown[]; byContractPath?: Record<string, unknown>; paths?: Record<string, unknown> }): LintContext {
  return {
    dsl: {
      boundaries: (partial.boundaries ?? []) as never,
      byContractPath: (partial.byContractPath ?? {}) as never,
    } as never,
    openapi: { raw: { paths: partial.paths ?? {} } } as never,
  };
}

describe('coverageCheck', () => {
  it('warns for OpenAPI operations with no boundary', () => {
    const findings = coverageCheck(ctx({
      byContractPath: { '/v1/customers': {} },
      boundaries: [{ contractPath: '/v1/customers', behaviors: [] }],
      paths: {
        '/v1/customers': { post: { operationId: 'PostCustomers' } },
        '/v1/payouts': { get: { operationId: 'GetPayouts' } },
      },
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].code).toBe('UNBOUNDED_OPERATION');
    expect(findings[0].message).toContain('/v1/payouts');
  });
});

describe('identityCheck', () => {
  it('errors when a parameterized mutating boundary lacks identity.key (non-id param)', () => {
    const findings = identityCheck(ctx({
      boundaries: [{ boundary: 'CustById', contractPath: '/v1/customers/{customer}', behaviors: [{ name: 'u' }] }],
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('IDENTITY_KEY_MISSING');
    expect(findings[0].location.boundary).toBe('CustById');
  });

  it('passes when identity.key is declared', () => {
    const findings = identityCheck(ctx({
      boundaries: [{ boundary: 'CustById', contractPath: '/v1/customers/{customer}', behaviors: [{ name: 'u' }], identity: { key: { from: 'path', name: 'customer' } } }],
    }));
    expect(findings).toHaveLength(0);
  });

  it('allows the implicit {id} fallback param without identity.key', () => {
    const findings = identityCheck(ctx({
      boundaries: [{ boundary: 'X', contractPath: '/things/{id}', behaviors: [{ name: 'u' }] }],
    }));
    expect(findings).toHaveLength(0);
  });

  it('ignores collection paths and query-only boundaries', () => {
    const findings = identityCheck(ctx({
      boundaries: [
        { boundary: 'Coll', contractPath: '/v1/customers', behaviors: [{ name: 'c' }] },
        { boundary: 'QById', contractPath: '/v1/customers/{customer}', behaviors: [] },
      ],
    }));
    expect(findings).toHaveLength(0);
  });
});
