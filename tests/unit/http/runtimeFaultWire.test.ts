import { parseRuntimeFaultWire } from '../../../src/http/runtimeFaultWire';
import { createDefaultRuntimeHost } from '../../../src/runtime/host';
import type { FaultContext } from '../../../src/model/runtime';
import type { Command } from '../../../src/contracts/domain';

const validRule = {
  name: 'temporary',
  match: { operationId: 'createThing' },
  response: { status: 503 },
};

describe('parseRuntimeFaultWire TTL validation', () => {
  it('converts a future expiry timestamp into a relative TTL', () => {
    expect(parseRuntimeFaultWire({ ...validRule, expiresAt: 2_500 }, 1_000).ttlMs).toBe(1_500);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['infinite', Number.POSITIVE_INFINITY],
    ['wrong type', '1000'],
  ])('rejects a %s TTL', (_name, ttlMs) => {
    expect(() => parseRuntimeFaultWire({ ...validRule, ttlMs }, 1_000)).toThrow(
      'Invalid fault TTL',
    );
  });

  it.each([
    ['past', 999],
    ['now', 1_000],
    ['infinite', Number.POSITIVE_INFINITY],
    ['wrong type', '2500'],
  ])('rejects an %s expiry timestamp', (_name, expiresAt) => {
    expect(() => parseRuntimeFaultWire({ ...validRule, expiresAt }, 1_000)).toThrow(
      'Invalid fault expiry',
    );
  });
});

describe('parseRuntimeFaultWire validation and matching', () => {
  const command: Command = {
    commandId: 'command-1',
    boundary: 'Order',
    intent: 'creation',
    targetId: 'order-1',
    payload: {},
    queryParams: {},
    httpMethod: 'post',
    path: '/orders',
    origin: 'inbound',
    depth: 0,
    operationId: 'createOrder',
  };
  const contextFor = (candidate: Command): FaultContext => {
    const host = createDefaultRuntimeHost();
    return {
      command: candidate,
      request: { command: candidate, headers: {} },
      state: null,
      payload: {},
      headers: {},
      helpers: host.helpers,
    };
  };

  it.each([null, [], 'fault', 1])('rejects a non-object fault rule: %p', (value) => {
    expect(() => parseRuntimeFaultWire(value, 1_000)).toThrow('Invalid fault rule');
  });

  it('applies defaults and preserves JSON response values', () => {
    const parsed = parseRuntimeFaultWire(
      {
        match: {},
        response: {
          status: 429,
          body: { nested: [true, null, { count: 1 }] },
          headers: { Retry: '2' },
          delay_ms: 4,
        },
      },
      1_000,
    );
    expect(parsed.rule).toMatchObject({
      name: 'dynamic-fault',
      response: {
        status: 429,
        body: { nested: [true, null, { count: 1 }] },
        headers: { Retry: '2' },
      },
      delayMs: 4,
    });
    expect(parsed.rule.matches(contextFor(command))).toBe(true);
  });

  it.each([
    ['missing response', { match: {} }],
    ['non-object match', { match: 'bad', response: { status: 500 } }],
    ['non-object response', { match: {}, response: 'bad' }],
    ['invalid status', { match: {}, response: { status: 99 } }],
    ['invalid response headers', { match: {}, response: { status: 500, headers: { Retry: 1 } } }],
    ['invalid match headers', { match: { headers: { Tenant: 1 } }, response: { status: 500 } }],
    ['unsupported condition', { match: { condition: 'state.ready' }, response: { status: 500 } }],
    ['invalid intent', { match: { intent: 'invalid' }, response: { status: 500 } }],
    ['invalid scopes', { match: { required_scopes: ['ok', 1] }, response: { status: 500 } }],
    ['invalid probability', { probability: 2, match: {}, response: { status: 500 } }],
    ['invalid delay', { delay_ms: -1, match: {}, response: { status: 500 } }],
  ] as const)('rejects %s', (_label, value) => {
    expect(() => parseRuntimeFaultWire(value, 1_000)).toThrow();
  });

  it('accepts typed conditions, selectors, scopes, operation aliases, and response delay', () => {
    const parsed = parseRuntimeFaultWire(
      {
        name: 'selected',
        match: {
          boundary: 'Order',
          intent: 'creation',
          operation_id: 'createOrder',
          method: 'post',
          condition: true,
          headers: { 'x-tenant': 'acme' },
          signal: 'rate-limit',
          forceResponse: 'forced',
          scenario: 'checkout',
          featureFlag: 'new-flow',
          errorClass: 'throttle',
          required_scopes: ['orders:write'],
        },
        response: { status: 503, delay_ms: 8 },
        probability: 0.5,
      },
      1_000,
    );
    expect(parsed.rule).toMatchObject({
      name: 'selected',
      headers: { 'x-tenant': 'acme' },
      selectors: {
        signal: 'rate-limit',
        forceResponse: 'forced',
        scenario: 'checkout',
        featureFlag: 'new-flow',
        errorClass: 'throttle',
      },
      requiredScopes: ['orders:write'],
      probability: 0.5,
      delayMs: 8,
    });
    expect(parsed.rule.matches(contextFor(command))).toBe(true);
    expect(parsed.rule.matches(contextFor({ ...command, operationId: 'otherOperation' }))).toBe(
      false,
    );
    expect(parsed.rule.matches(contextFor({ ...command, boundary: 'Other' }))).toBe(false);
    expect(parsed.rule.matches(contextFor({ ...command, intent: 'query' }))).toBe(false);
    expect(parsed.rule.matches(contextFor({ ...command, httpMethod: 'GET' }))).toBe(false);
  });

  it('accepts the documented wire condition string and rejects invalid JSON recursively', () => {
    expect(
      parseRuntimeFaultWire({ match: { condition: 'true' }, response: { status: 500 } }, 1_000)
        .rule,
    ).toBeDefined();
    expect(() =>
      parseRuntimeFaultWire(
        { match: {}, response: { status: 500, body: { invalid: undefined } } },
        1_000,
      ),
    ).toThrow('Invalid fault response body');
  });
});
