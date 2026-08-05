import { validateBoundaryConfig, validateGlobalConfig } from '../../../src/dsl/schema.js';

const boundaryWithEveryOptionalBlock = {
  boundary: 'Order',
  contract_path: '/orders',
  fallback_override: true,
  identity: {
    creation: { generate: '$uuidv7()' },
    key: { from: 'payload', pointer: '/id' },
  },
  query_mapping: { status: "state.status == 'CREATED'" },
  query: {
    fields: { id: 'state.id' },
    filter: 'true',
    sort: [{ field: 'id', direction: 'desc' }],
    page_size: 10,
    max_page_size: 25,
    cursor: 'true',
    expand: ['customer'],
    pagination: 'envelope',
    include_deleted: true,
    fallback: 'true',
  },
  behaviors: [
    {
      name: 'create-order',
      response_status: 202,
      match: {
        operationId: 'createOrder',
        condition: 'true',
        method: 'post',
        headers: { 'x-order-mode': 'present' },
        required_scopes: ['orders:write'],
        requires: [
          {
            name: 'order-is-allowed',
            condition: 'true',
            error_code: 'ORDER_NOT_ALLOWED',
            error_message: 'Order is not allowed',
            error_status: 422,
          },
        ],
      },
      emit_when: [{ when: 'true', emit: 'OrderCreated' }],
      postcondition: 'true',
      link_name: 'self',
      link_condition: 'true',
      dispatch_commands: [
        {
          boundary: 'Receipt',
          intent: 'creation',
          operationId: 'createReceipt',
          target_id: 'command.payload.id',
          payload: { orderId: 'command.payload.id' },
          condition: 'true',
        },
      ],
    },
  ],
  reducers: [
    {
      on: 'OrderCreated',
      replace_state: false,
      patches: [
        { op: 'replace', path: '/status', value: '${"CREATED"}' },
        { op: 'increment', path: '/attempts', by: 1 },
      ],
    },
  ],
  event_catalog: [
    {
      type: 'OrderCreated',
      payload_template: { id: 'event.payload.id' },
      schema_ref: 'Order',
    },
  ],
  initialization: [{ id: 'seed-order', status: 'CREATED' }],
  deprecated: {
    date: '2026-01-01',
    sunset: '2026-12-31',
    replacement: '/v2/orders',
  },
  hateoas: [{ rel: 'self', href: '/orders/{id}' }],
  mask: ['/internalNote'],
  state: {
    computed: [{ name: 'display', formula: 'state.status', depends_on: ['/status'] }],
    internal: [{ name: 'internalNote', type: 'string' }],
  },
  strict_schema: true,
  audit_fields: true,
  fault_rules: [
    {
      name: 'order-outage',
      match: {
        boundary: 'Order',
        intent: 'creation',
        operationId: 'createOrder',
        method: 'POST',
        condition: 'true',
        headers: { 'x-order-mode': 'present' },
        potemkin: { rate_limit: 'off' },
        required_scopes: ['orders:write'],
        requires: [{ name: 'fault-guard', condition: 'true' }],
        probability: 1,
      },
      response: { status: 503, body: { error: 'OUTAGE' }, headers: { Retry: '1' } },
      delay_ms: 5,
    },
  ],
  reactions: [
    {
      name: 'record-order',
      on: 'OrderCreated',
      emit: 'OrderCreated',
      intent: 'mutation',
      when: 'true',
      target: 'event.aggregateId',
      payload: { orderId: 'event.aggregateId' },
    },
  ],
  response: 'order-response',
  include: [{ component: 'CommonOrderFields', with: { tenant: 'acme' } }],
  export: {
    states: [
      {
        name: 'created',
        saga: 'order-saga',
        steps: [{ operationId: 'createOrder', body: { id: 'example' }, headers: { Demo: 'true' } }],
      },
    ],
  },
  schema: 'Order',
};

const globalWithEveryOptionalBlock = {
  sagas: [
    {
      name: 'order-saga',
      trigger: { boundary: 'Order', intent: 'creation', condition: 'true' },
      steps: [
        {
          name: 'create-receipt',
          boundary: 'Receipt',
          intent: 'creation',
          operationId: 'createReceipt',
          target_id: 'command.payload.id',
          payload: { orderId: 'command.payload.id' },
          compensation: {
            intent: 'mutation',
            operationId: 'cancelReceipt',
            target_id: 'command.payload.id',
            payload: { orderId: 'command.payload.id' },
          },
        },
      ],
    },
  ],
  idempotency: { enabled: false, ttl_seconds: 30, hash_includes_body: false },
  derived_projections: [
    {
      name: 'order-summary',
      key: 'event.aggregateId',
      subscribe: ['OrderCreated'],
      reduce: [
        {
          on: 'OrderCreated',
          patches: [{ op: 'replace', path: '/id', value: '${event.payload.id}' }],
        },
      ],
    },
  ],
  auth: {
    mode: 'jwt',
    jwt: {
      secret: 'test-secret',
      algorithm: 'HS256',
      issuer: 'issuer',
      audience: 'audience',
      subject_claim: 'sub',
      scopes_claim: 'scope',
      required_claims: { tenant: 'acme' },
    },
    session: {
      cookie_name: 'sid',
      ttl_seconds: 60,
      csrf: true,
      csrf_header: 'x-csrf-token',
      login_path: '/login',
      logout_path: '/logout',
    },
  },
  hateoas: { enabled: true, base_url: 'https://example.test', self_links: true },
  versioning: {
    enabled: true,
    versions: [
      { version: 'v1', prefix: '/v1' },
      { version: 'v2', prefix: '/v2', default: true },
    ],
  },
  security_headers: {
    enabled: true,
    hsts: true,
    nosniff: true,
    frame_deny: true,
    referrer_policy: 'no-referrer',
    custom_headers: { 'x-test': 'true' },
  },
  fault_rules: [
    {
      name: 'global-outage',
      match: {
        boundary: 'Order',
        intent: 'creation',
        operationId: 'createOrder',
        method: 'POST',
        condition: 'true',
        headers: { 'x-order-mode': 'present' },
        required_scopes: ['orders:write'],
        requires: [{ name: 'guard', condition: 'true' }],
        probability: 1,
      },
      response: { status: 503, body: { error: 'OUTAGE' }, headers: { Retry: '1' } },
      delay_ms: 5,
    },
  ],
  webhooks: [
    {
      name: 'order-webhook',
      trigger: { boundary: 'Order', intent: 'creation', condition: 'true' },
      url: "'https://example.test/orders'",
      secret: 'secret',
      payload: { id: 'event.aggregateId' },
      retry: { maxAttempts: 2, delayMs: 10 },
    },
  ],
  reactions: [
    {
      name: 'global-reaction',
      boundary: 'Order',
      on: 'OrderCreated',
      emit: 'OrderCreated',
      intent: 'mutation',
      when: 'true',
      target: 'event.aggregateId',
      payload: { id: 'event.aggregateId' },
    },
  ],
  fallback: {
    rules: [
      {
        match: { path: '/orders/**', method: 'GET', in_contract: true },
        respond: { status: 404, body: { error: 'NOT_FOUND' } },
      },
    ],
    default: { status: 404, body: { error: 'NO_ROUTE' } },
  },
  coverage: {
    Order: {
      strict: true,
      initial_states: ['NEW'],
      terminal_states: ['DONE'],
      operations: ['createOrder'],
      suppress_states: ['CANCELLED'],
    },
  },
};

describe('YAML DSL schema option matrix', () => {
  it('normalizes a boundary containing every optional authoring block', () => {
    const parsed = validateBoundaryConfig(boundaryWithEveryOptionalBlock);

    expect(parsed).toMatchObject({
      boundary: 'Order',
      contractPath: '/orders',
      fallbackOverride: true,
      identity: { key: { from: 'payload', pointer: '/id' } },
      query: { pagination: 'envelope', includeDeleted: true },
      deprecated: { replacement: '/v2/orders' },
      strictSchema: true,
      auditFields: true,
      response: 'order-response',
      schema: 'Order',
    });
    expect(parsed.behaviors[0]?.emitWhen).toHaveLength(1);
    expect(parsed.behaviors[0]?.dispatchCommands).toHaveLength(1);
    expect(parsed.reducers[0]?.patches).toHaveLength(2);
    expect(parsed.export?.states[0]?.steps).toHaveLength(1);
  });

  it('normalizes every global configuration block into its typed shape', () => {
    const parsed = validateGlobalConfig(globalWithEveryOptionalBlock);

    expect(parsed).toMatchObject({
      idempotency: { enabled: false, ttlSeconds: 30, hashIncludesBody: false },
      auth: { mode: 'jwt', jwt: { issuer: 'issuer' }, session: { cookieName: 'sid' } },
      hateoas: { enabled: true, baseUrl: 'https://example.test', selfLinks: true },
      versioning: { enabled: true },
      securityHeaders: { enabled: true, custom_headers: { 'x-test': 'true' } },
      fallback: { default: { status: 404 } },
    });
    expect(parsed.sagas?.[0]?.steps[0]?.compensation?.operationId).toBe('cancelReceipt');
    expect(parsed.derivedProjections?.[0]?.reduce).toHaveLength(1);
    expect(parsed.faults?.[0]?.match.requiredScopes).toEqual(['orders:write']);
    expect(parsed.webhooks?.[0]?.retry).toEqual({ maxAttempts: 2, delayMs: 10 });
    expect(parsed.reactions?.[0]?.boundary).toBe('Order');
    expect(parsed.coverage?.Order?.terminal_states).toEqual(['DONE']);
  });

  it.each([
    ['fallback_override', 'invalid'],
    ['identity', 'invalid'],
    ['query_mapping', []],
    ['query', 'invalid'],
    ['behaviors', 'invalid'],
    ['reducers', 'invalid'],
    ['event_catalog', 'invalid'],
    ['initialization', 'invalid'],
    ['deprecated', 'invalid'],
    ['hateoas', 'invalid'],
    ['mask', 'invalid'],
    ['state', 'invalid'],
    ['strict_schema', 'invalid'],
    ['audit_fields', 'invalid'],
    ['fault_rules', 'invalid'],
    ['reactions', 'invalid'],
    ['response', 1],
    ['include', 'invalid'],
    ['export', 'invalid'],
    ['schema', 1],
  ] as const)('rejects a malformed boundary %s block', (key, value) => {
    expect(() =>
      validateBoundaryConfig({ ...boundaryWithEveryOptionalBlock, [key]: value }),
    ).toThrow();
  });

  it.each([
    ['sagas', 'invalid'],
    ['idempotency', 'invalid'],
    ['derived_projections', 'invalid'],
    ['auth', 'invalid'],
    ['hateoas', 'invalid'],
    ['versioning', 'invalid'],
    ['security_headers', 'invalid'],
    ['fault_rules', 'invalid'],
    ['webhooks', 'invalid'],
    ['reactions', 'invalid'],
    ['fallback', 'invalid'],
    ['coverage', 'invalid'],
  ] as const)('rejects a malformed global %s block', (key, value) => {
    expect(() => validateGlobalConfig({ ...globalWithEveryOptionalBlock, [key]: value })).toThrow();
  });

  it('accepts sparse optional blocks and applies their documented defaults', () => {
    const boundary = validateBoundaryConfig({
      boundary: 'Sparse',
      contract_path: '/sparse',
      identity: { key: { from: 'payload', pointer: '/id' } },
      query: {},
      query_mapping: {},
      behaviors: [],
      reducers: [],
      event_catalog: [],
      initialization: [],
      deprecated: {},
      hateoas: [],
      mask: [],
      state: { computed: [], internal: [] },
      strict_schema: false,
      audit_fields: false,
      fault_rules: [],
      reactions: [],
      include: [],
      export: {
        states: [{ name: 'sparse', steps: [{ operationId: 'noop' }] }],
      },
    });
    expect(boundary.fallbackOverride).toBe(false);
    expect(boundary.deprecated?.date).toBe('1970-01-01T00:00:00.000Z');

    const global = validateGlobalConfig({
      sagas: [
        {
          name: 'empty-saga',
          trigger: { boundary: 'Sparse', intent: 'query', condition: 'true' },
          steps: [],
        },
      ],
      idempotency: {},
      derived_projections: [
        { name: 'empty-projection', key: 'event.aggregateId', subscribe: [], reduce: [] },
      ],
      auth: { mode: 'simple' },
      hateoas: {},
      versioning: {},
      security_headers: {},
      fault_rules: [{ name: 'minimal', match: {}, response: { status: 500 } }],
      webhooks: [{ name: 'minimal', trigger: {}, url: "'https://example.test'" }],
      reactions: [{ name: 'minimal', boundary: 'Sparse', on: 'Sparse:Created', emit: 'Recorded' }],
      fallback: {},
      coverage: { Sparse: {} },
    });
    expect(global.idempotency).toEqual({
      enabled: true,
      ttlSeconds: 86400,
      hashIncludesBody: true,
    });
    expect(global.sagas?.[0]?.steps).toEqual([]);
    expect(global.coverage?.Sparse).toEqual({});
  });
});
