import { parseRuntimeFaultRegistration } from '../../../src/parser/runtimeAdmin';
import { createCelEvaluator } from '../../../src/cel/evaluator';

const cel = createCelEvaluator({
  now: () => '2030-01-02T03:04:05.000Z',
  random: () => 0,
  uuid: () => '00000000-0000-7000-8000-000000000001',
});

const validRule = {
  name: 'temporary',
  match: { operationId: 'createThing' },
  response: { status: 503 },
};

describe('parseRuntimeFaultRegistration TTL validation', () => {
  it('converts a future expiry timestamp into a relative TTL', () => {
    expect(
      parseRuntimeFaultRegistration({ ...validRule, expiresAt: 2_500 }, { nowMs: 1_000, cel })
        .ttlMs,
    ).toBe(1_500);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['infinite', Number.POSITIVE_INFINITY],
    ['wrong type', '1000'],
  ])('rejects a %s TTL', (_name, ttlMs) => {
    expect(() =>
      parseRuntimeFaultRegistration({ ...validRule, ttlMs }, { nowMs: 1_000, cel }),
    ).toThrow('Invalid fault TTL');
  });

  it.each([
    ['past', 999],
    ['now', 1_000],
    ['infinite', Number.POSITIVE_INFINITY],
    ['wrong type', '2500'],
  ])('rejects an %s expiry timestamp', (_name, expiresAt) => {
    expect(() =>
      parseRuntimeFaultRegistration({ ...validRule, expiresAt }, { nowMs: 1_000, cel }),
    ).toThrow('Invalid fault expiry');
  });

  it.each([null, [], {}, { match: {} }, { response: {} }, { match: {}, response: null }])(
    'rejects a malformed fault envelope: %j',
    (value) => {
      expect(() => parseRuntimeFaultRegistration(value, { nowMs: 1_000, cel })).toThrow(
        'Invalid fault rule',
      );
    },
  );

  it.each([99, 600, 200.5, '503'])('rejects an invalid response status %j', (status) => {
    expect(() =>
      parseRuntimeFaultRegistration({ ...validRule, response: { status } }, { nowMs: 1_000, cel }),
    ).toThrow('Invalid fault response status');
  });

  it('applies default condition/name and selects the valid delay source', () => {
    const topLevel = parseRuntimeFaultRegistration(
      {
        match: { operationId: 'createThing' },
        response: { status: 503, delay_ms: 25 },
        delay_ms: 10,
      },
      { nowMs: 1_000, cel },
    );
    expect(topLevel).toMatchObject({ rule: { name: 'dynamic-fault', delayMs: 10 } });

    const responseLevel = parseRuntimeFaultRegistration(
      {
        match: { operationId: 'createThing', condition: 42 },
        response: { status: 503, delay_ms: 25 },
        delay_ms: -1,
      },
      { nowMs: 1_000, cel },
    );
    expect(responseLevel).toMatchObject({ rule: { delayMs: 25 } });

    const noDelay = parseRuntimeFaultRegistration(
      { name: '  ', match: { operationId: 'createThing' }, response: { status: 503 } },
      { nowMs: 1_000, cel },
    );
    expect(noDelay.rule.delayMs).toBeUndefined();
  });

  it('preserves typed optional fault fields while crossing the admin boundary', () => {
    const result = parseRuntimeFaultRegistration(
      {
        name: 'scoped-outage',
        match: {
          boundary: 'orders',
          intent: 'mutation',
          operationId: 'updateOrder',
          method: 'patch',
          headers: { 'x-tenant': 'acme' },
          requiredScopes: ['orders:write'],
          probability: 0.5,
          requires: [
            {
              name: 'tenant-enabled',
              condition: 'true',
              errorCode: 'TENANT_DISABLED',
              errorMessage: 'tenant is disabled',
            },
          ],
        },
        response: {
          status: 503,
          body: { error: 'outage' },
          headers: { 'retry-after': '10' },
        },
      },
      { nowMs: 1_000, cel },
    );

    expect(result.rule).toMatchObject({
      name: 'scoped-outage',
      headers: { 'x-tenant': 'acme' },
      requiredScopes: ['orders:write'],
      probability: 0.5,
      response: {
        status: 503,
        body: { error: 'outage' },
        headers: { 'retry-after': '10' },
      },
    });
    expect(result.rule.requires).toHaveLength(1);
  });
});
