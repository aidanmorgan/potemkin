import { validateGlobalConfig } from '../../../src/dsl/schema';
import { BootError } from '../../../src/errors';

describe('global DSL option matrix', () => {
  it('normalizes every supported global policy into the typed configuration', () => {
    const config = validateGlobalConfig({
      sagas: [
        {
          name: 'reserve-order',
          trigger: { boundary: 'Order', intent: 'creation', condition: 'true' },
          steps: [
            {
              name: 'reserve',
              boundary: 'Inventory',
              intent: 'mutation',
              operationId: 'reserveInventory',
              target_id: 'event.aggregateId',
              payload: { orderId: 'event.aggregateId' },
              compensation: {
                intent: 'mutation',
                operationId: 'releaseInventory',
                target_id: 'event.aggregateId',
                payload: { orderId: 'event.aggregateId' },
              },
            },
          ],
        },
      ],
      idempotency: { enabled: false, ttl_seconds: 60, hash_includes_body: false },
      derived_projections: [
        {
          name: 'order-summary',
          key: 'event.aggregateId',
          subscribe: ['OrderCreated'],
          reduce: [
            {
              on: 'OrderCreated',
              patches: [{ op: 'replace', path: '/status', value: '${event.payload.status}' }],
            },
          ],
        },
      ],
      auth: {
        mode: 'session',
        jwt: {
          secret: 'secret',
          algorithm: 'HS256',
          issuer: 'issuer',
          audience: 'audience',
          subject_claim: 'sub',
          scopes_claim: 'scope',
          required_claims: { tenant: 'acme' },
        },
        session: {
          cookie_name: 'sid',
          ttl_seconds: 120,
          csrf: true,
          csrf_header: 'x-csrf',
          login_path: '/login',
          logout_path: '/logout',
        },
      },
      hateoas: { enabled: true, base_url: 'https://api.example', self_links: true },
      versioning: {
        enabled: true,
        versions: [
          { version: 'v1', prefix: '/v1' },
          { version: 'v2', prefix: '/v2', default: false },
        ],
      },
      security_headers: {
        enabled: true,
        hsts: true,
        nosniff: true,
        frame_deny: true,
        referrer_policy: 'no-referrer',
        custom_headers: { 'X-Policy': 'strict' },
      },
      fault_rules: [
        {
          name: 'outage',
          match: {
            boundary: 'Order',
            intent: 'mutation',
            operationId: 'createOrder',
            method: 'post',
            headers: { 'x-test': 'present' },
            required_scopes: ['admin'],
            requires: [
              { name: 'enabled', condition: 'true', error_code: 'DISABLED', message: 'disabled' },
            ],
            probability: 0.5,
            condition: 'true',
          },
          response: { status: 503, body: { code: 'OUTAGE' }, headers: { Retry: '1' } },
          delay_ms: 25,
        },
      ],
      webhooks: [
        {
          name: 'notify',
          trigger: { boundary: 'Order', intent: 'creation', condition: 'true' },
          url: 'https://hooks.example/orders',
          secret: 'webhook-secret',
          payload: { id: 'event.aggregateId' },
          retry: { maxAttempts: 3, delayMs: 10 },
        },
      ],
      reactions: [
        {
          name: 'notify-inventory',
          boundary: 'Inventory',
          on: 'OrderCreated',
          intent: 'mutation',
          when: 'true',
          target: 'event.aggregateId',
          emit: 'InventoryReserved',
          payload: { orderId: 'event.aggregateId' },
        },
      ],
      fallback: {
        rules: [
          {
            match: { path: '/legacy', method: 'GET', in_contract: false },
            respond: { status: 410, body: { code: 'GONE' } },
          },
        ],
        default: { status: 404, body: { code: 'NOT_FOUND' } },
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
    });

    expect(config).toMatchObject({
      idempotency: { enabled: false, ttlSeconds: 60, hashIncludesBody: false },
      auth: {
        mode: 'session',
        jwt: { algorithm: 'HS256', issuer: 'issuer', audience: 'audience' },
        session: { cookieName: 'sid', loginPath: '/login', logoutPath: '/logout' },
      },
      versioning: { enabled: true, versions: [{ version: 'v1' }, { version: 'v2' }] },
      fallback: { default: { status: 404 } },
      coverage: { Order: { strict: true, initial_states: ['NEW'] } },
    });
    expect(config.sagas?.[0]?.steps[0]?.compensation?.operationId).toBe('releaseInventory');
    expect(config.derivedProjections?.[0]?.reduce[0]?.patches).toHaveLength(1);
    expect(config.faults?.[0]?.match.requires).toHaveLength(1);
    expect(config.webhooks?.[0]?.retry).toEqual({ maxAttempts: 3, delayMs: 10 });
    expect(config.reactions?.[0]?.payload).toEqual({ orderId: 'event.aggregateId' });
  });

  it.each([
    ['sagas', { sagas: 'bad' }],
    ['idempotency', { idempotency: 'bad' }],
    ['derived projections', { derived_projections: 'bad' }],
    ['auth', { auth: 'bad' }],
    ['hateoas', { hateoas: 'bad' }],
    ['versioning', { versioning: 'bad' }],
    ['security headers', { security_headers: 'bad' }],
    ['faults', { fault_rules: 'bad' }],
    ['webhooks', { webhooks: 'bad' }],
    ['reactions', { reactions: 'bad' }],
  ])('rejects a non-array or non-mapping %s block', (_name, value) => {
    expect(() => validateGlobalConfig(value)).toThrow(BootError);
  });

  it.each([
    ['coverage', { coverage: 'bad' }],
    ['fallback', { fallback: 'bad' }],
    ['auth jwt', { auth: { jwt: { secret: '' } } }],
    ['auth session', { auth: { session: 'bad' } }],
    ['version list', { versioning: { versions: 'bad' } }],
    ['security headers map', { security_headers: 'bad' }],
  ])('rejects malformed nested %s configuration', (_name, value) => {
    expect(() => validateGlobalConfig(value)).toThrow(BootError);
  });
});
