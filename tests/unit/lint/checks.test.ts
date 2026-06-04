import { coverageCheck } from '../../../src/lint/checks/coverage';
import { identityCheck } from '../../../src/lint/checks/identity';
import { referencesCheck } from '../../../src/lint/checks/references';
import { requiredFieldsCheck } from '../../../src/lint/checks/requiredFields';
import type { LintContext } from '../../../src/lint/types';

function ctx(partial: { boundaries?: unknown[]; byContractPath?: Record<string, unknown>; paths?: Record<string, unknown>; schemas?: Record<string, unknown> }): LintContext {
  return {
    dsl: {
      boundaries: (partial.boundaries ?? []) as never,
      byContractPath: (partial.byContractPath ?? {}) as never,
    } as never,
    openapi: { raw: { paths: partial.paths ?? {}, components: { schemas: partial.schemas ?? {} } } } as never,
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

describe('referencesCheck', () => {
  const schemas = { widget: { properties: { id: {}, name: {}, color: {} } } };

  it('errors when mask names a field not in the schema', () => {
    const findings = referencesCheck(ctx({
      schemas,
      boundaries: [{ boundary: 'widget', contractPath: '/widgets', behaviors: [], mask: ['name', 'colour'] }],
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('MASK_FIELD_UNKNOWN');
    expect(findings[0].message).toContain('colour');
  });

  it('passes when all mask fields exist; skips open (additionalProperties) schemas', () => {
    expect(referencesCheck(ctx({
      schemas,
      boundaries: [{ boundary: 'widget', contractPath: '/widgets', behaviors: [], mask: ['name', 'color'] }],
    }))).toHaveLength(0);

    expect(referencesCheck(ctx({
      schemas: { open: { additionalProperties: true, properties: { id: {} } } },
      boundaries: [{ boundary: 'open', contractPath: '/o', behaviors: [], mask: ['anything'] }],
    }))).toHaveLength(0);
  });
});

describe('requiredFieldsCheck', () => {
  const schemas = { charge: { required: ['id', 'amount', 'currency', 'status'] } };
  const creation = { creation: { generate: 'ts:chargeId' } };

  it('errors when the create reducer omits a required field (id excluded)', () => {
    const findings = requiredFieldsCheck(ctx({
      schemas,
      boundaries: [{
        boundary: 'charge', contractPath: '/charges', identity: creation,
        behaviors: [{ name: 'create', emit: 'ChargeCreated' }],
        eventCatalog: [],
        reducers: [{ on: 'ChargeCreated', patches: [
          { op: 'replace', path: '/amount', value: '' },
          { op: 'replace', path: '/status', value: '' },
        ] }],
      }],
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('REQUIRED_FIELD_UNSET');
    // The missing-field list contains only 'currency'; 'id' is engine-set and excluded.
    expect(findings[0].message).toMatch(/field\(s\) \[currency\]/);
  });

  it('passes when replace_state covers required fields via the event payload', () => {
    const findings = requiredFieldsCheck(ctx({
      schemas,
      boundaries: [{
        boundary: 'charge', contractPath: '/charges', identity: creation,
        behaviors: [{ name: 'create', emit: 'ChargeCreated' }],
        eventCatalog: [{ type: 'ChargeCreated', payloadTemplate: { amount: '', currency: '', status: '' } }],
        reducers: [{ on: 'ChargeCreated', replaceState: true }],
      }],
    }));
    expect(findings).toHaveLength(0);
  });

  it('skips boundaries whose create reducer is a TypeScript reducer', () => {
    const findings = requiredFieldsCheck(ctx({
      schemas,
      boundaries: [{
        boundary: 'charge', contractPath: '/charges', identity: creation,
        behaviors: [{ name: 'create', emit: 'ChargeCreated' }],
        eventCatalog: [],
        reducers: [{ on: 'ChargeCreated', implementation: 'typescript' }],
      }],
    }));
    expect(findings).toHaveLength(0);
  });

  it('skips non-creation boundaries', () => {
    const findings = requiredFieldsCheck(ctx({
      schemas,
      boundaries: [{
        boundary: 'chargeById', contractPath: '/charges/{id}',
        behaviors: [{ name: 'u', emit: 'ChargeUpdated' }], eventCatalog: [],
        reducers: [{ on: 'ChargeUpdated', patches: [{ op: 'replace', path: '/amount', value: '' }] }],
      }],
    }));
    expect(findings).toHaveLength(0);
  });
});
