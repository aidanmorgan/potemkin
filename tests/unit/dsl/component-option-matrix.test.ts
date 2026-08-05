import {
  validateComponentConfig,
  validateIncludeEntries,
  validateUseEntries,
  validateUseMappingConfig,
} from '../../../src/dsl/schema.js';

const componentWithEverySupportedBlock = {
  kind: 'component',
  name: 'CommonOrder',
  parameters: {
    tenant: { type: 'string', default: 'acme' },
    retries: { type: 'number', default: 2 },
    enabled: { type: 'boolean', required: false },
  },
  event_catalog: [
    { type: 'OrderCreated', payload_template: { id: 'event.payload.id' } },
    { type: 'OrderAudited', payload_template: {} },
  ],
  reducers: [{ on: 'OrderCreated', patches: [{ op: 'replace', path: '/id', value: '1' }] }],
  behaviors: [
    {
      name: 'create',
      match: { operationId: 'createOrder', condition: 'true' },
      emit: 'OrderCreated',
    },
  ],
  identity: { creation: { generate: 'command.payload.id' } },
  state: {
    computed: [{ name: 'display', formula: 'state.id', depends_on: ['id'] }],
    internal: [{ name: 'auditId', type: 'string' }],
  },
  schema: 'Order',
  fallback_override: true,
  query: {},
  query_mapping: { tenant: 'true' },
  deprecated: { date: '2026-01-01', sunset: '2026-12-31', replacement: '/v2/orders' },
  hateoas: [{ rel: 'self', href: '/orders/{id}' }],
  mask: ['/auditId'],
  strict_schema: true,
  audit_fields: true,
  fault_rules: [{ name: 'outage', match: {}, response: { status: 503 } }],
  reactions: [{ on: 'OrderCreated', emit: 'OrderAudited' }],
  include: [{ component: 'CommonFields', with: { tenant: 'acme' } }],
};

describe('component authoring option matrix', () => {
  it('normalizes every supported component block', () => {
    const parsed = validateComponentConfig(componentWithEverySupportedBlock);
    expect(parsed).toMatchObject({
      kind: 'component',
      name: 'CommonOrder',
      parameters: {
        tenant: { type: 'string', default: 'acme' },
        retries: { type: 'number', default: 2 },
      },
      fallbackOverride: true,
      schema: 'Order',
      strictSchema: true,
      auditFields: true,
      queryMapping: { tenant: 'true' },
      include: [{ component: 'CommonFields', with: { tenant: 'acme' } }],
    });
    expect(parsed.eventCatalog).toHaveLength(2);
    expect(parsed.reactions).toHaveLength(1);
    expect(parsed.faults).toHaveLength(1);
    expect(parsed.state?.computed).toHaveLength(1);
  });

  it.each([
    ['root', null],
    ['kind', { kind: 'boundary', name: 'X' }],
    ['name', { kind: 'component', name: 1 }],
    ['parameters', { ...componentWithEverySupportedBlock, parameters: 'bad' }],
    ['event_catalog', { ...componentWithEverySupportedBlock, event_catalog: 'bad' }],
    ['reducers', { ...componentWithEverySupportedBlock, reducers: 'bad' }],
    ['behaviors', { ...componentWithEverySupportedBlock, behaviors: 'bad' }],
    ['identity', { ...componentWithEverySupportedBlock, identity: 'bad' }],
    ['state', { ...componentWithEverySupportedBlock, state: 'bad' }],
    ['query', { ...componentWithEverySupportedBlock, query: 'bad' }],
    ['query_mapping', { ...componentWithEverySupportedBlock, query_mapping: 'bad' }],
    ['deprecated', { ...componentWithEverySupportedBlock, deprecated: 'bad' }],
    ['hateoas', { ...componentWithEverySupportedBlock, hateoas: 'bad' }],
    ['mask', { ...componentWithEverySupportedBlock, mask: 'bad' }],
    ['fault_rules', { ...componentWithEverySupportedBlock, fault_rules: 'bad' }],
    ['reactions', { ...componentWithEverySupportedBlock, reactions: 'bad' }],
    ['include', { ...componentWithEverySupportedBlock, include: 'bad' }],
    ['unknown key', { ...componentWithEverySupportedBlock, typo: true }],
  ] as const)('rejects malformed component %s', (_label, raw) => {
    expect(() => validateComponentConfig(raw)).toThrow();
  });

  it.each([
    ['unknown parameter type', { type: 'integer' }],
    ['non-object parameter', 'bad'],
    ['non-boolean required', { type: 'string', required: 'yes' }],
    ['required default conflict', { type: 'string', required: true, default: 'x' }],
    ['default type mismatch', { type: 'number', default: 'x' }],
  ] as const)('rejects %s', (_label, parameter) => {
    expect(() =>
      validateComponentConfig({
        kind: 'component',
        name: 'Parameters',
        parameters: { value: parameter },
      }),
    ).toThrow();
  });

  it.each([
    ['invalid state computed container', { computed: 'bad' }],
    ['invalid computed entry', { computed: ['bad'] }],
    ['invalid computed formula', { computed: [{ name: 'x', formula: '!', depends_on: [] }] }],
    ['invalid depends_on', { computed: [{ name: 'x', formula: 'true', depends_on: 'x' }] }],
    ['invalid depends_on entry', { computed: [{ name: 'x', formula: 'true', depends_on: [1] }] }],
    ['invalid internal container', { internal: 'bad' }],
    ['invalid internal entry', { internal: ['bad'] }],
    ['unknown internal type', { internal: [{ name: 'x', type: 'date' }] }],
  ] as const)('rejects %s', (_label, state) => {
    expect(() => validateComponentConfig({ kind: 'component', name: 'State', state })).toThrow();
  });
});

describe('use and include boundary mappings', () => {
  const validUse = {
    component: 'CommonOrder',
    as: 'Order',
    contract_path: '/orders',
    with: { tenant: 'acme', retries: 2, enabled: true },
    bind: { Related: 'Receipt' },
  };

  it('accepts bindings with all scalar parameter types', () => {
    expect(validateUseEntries([validUse], 'root')).toEqual([
      {
        component: 'CommonOrder',
        as: 'Order',
        contractPath: '/orders',
        with: { tenant: 'acme', retries: 2, enabled: true },
        bind: { Related: 'Receipt' },
      },
    ]);
    expect(
      validateIncludeEntries([{ component: 'CommonOrder', with: { enabled: false } }], 'root'),
    ).toEqual([{ component: 'CommonOrder', with: { enabled: false } }]);
    expect(validateUseMappingConfig({ use: [validUse] })).toHaveLength(1);
  });

  it.each([
    ['use root', 'bad', 'root'],
    ['use entry', ['bad'], 'root'],
    ['use with', [{ ...validUse, with: 'bad' }], 'root'],
    ['use bind', [{ ...validUse, bind: { Related: 1 } }], 'root'],
    ['include root', 'bad', 'root'],
    ['include entry', ['bad'], 'root'],
    ['include with', [{ component: 'CommonOrder', with: [] }], 'root'],
  ] as const)('rejects malformed %s', (_label, raw, ctx) => {
    const validate = _label.startsWith('include') ? validateIncludeEntries : validateUseEntries;
    expect(() => validate(raw, ctx)).toThrow();
  });

  it.each([
    ['use empty', { use: [] }],
    ['use missing', {}],
    ['use non-object', 'bad'],
  ] as const)('rejects %s mapping files', (_label, raw) => {
    expect(() => validateUseMappingConfig(raw)).toThrow();
  });
});
