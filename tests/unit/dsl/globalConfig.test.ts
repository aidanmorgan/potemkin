/**
 * Unit tests for validateGlobalConfig — the global (top-level) DSL config parser.
 *
 * Two responsibilities under audit:
 *   1. FAIL-FAST: an unknown top-level key must throw (never silently dropped).
 *   2. Parse every supported block (versioning / security_headers / fault_rules /
 *      webhooks / hateoas) into the typed shape the engine consumes.
 */

import { validateGlobalConfig } from '../../../src/dsl/schema';
import { BootError } from '../../../src/errors';

describe('validateGlobalConfig — fail-fast on unknown keys', () => {
  it('throws BootError on an unknown top-level key', () => {
    expect(() => validateGlobalConfig({ totally_unknown_block: { a: 1 } })).toThrow(BootError);
  });

  it('names the offending key and lists supported keys', () => {
    let err: unknown;
    try {
      validateGlobalConfig({ webooks: [] }); // deliberate typo of "webhooks"
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BootError);
    expect((err as Error).message).toContain('webooks');
    expect((err as Error).message).toContain('webhooks');
  });

  it('accepts an empty config', () => {
    expect(validateGlobalConfig({})).toEqual({});
  });
});

describe('validateGlobalConfig — versioning', () => {
  it('parses versions with prefixes and a default flag', () => {
    const cfg = validateGlobalConfig({
      versioning: {
        enabled: true,
        versions: [
          { version: 'v1', prefix: '/v1' },
          { version: 'v2', prefix: '/v2', default: true },
        ],
      },
    });
    expect(cfg.versioning?.enabled).toBe(true);
    expect(cfg.versioning?.versions).toHaveLength(2);
    expect(cfg.versioning?.versions?.[1]).toMatchObject({ version: 'v2', prefix: '/v2', default: true });
  });

  it('rejects more than one default version', () => {
    expect(() => validateGlobalConfig({
      versioning: {
        enabled: true,
        versions: [
          { version: 'v1', prefix: '/v1', default: true },
          { version: 'v2', prefix: '/v2', default: true },
        ],
      },
    })).toThrow(BootError);
  });

  it('requires a prefix on each version', () => {
    expect(() => validateGlobalConfig({
      versioning: { enabled: true, versions: [{ version: 'v1' }] },
    })).toThrow(BootError);
  });
});

describe('validateGlobalConfig — security_headers', () => {
  it('parses standard toggles and custom headers', () => {
    const cfg = validateGlobalConfig({
      security_headers: {
        enabled: true,
        hsts: true,
        nosniff: true,
        frame_deny: true,
        referrer_policy: 'no-referrer',
        custom_headers: { 'X-Sim': 'on' },
      },
    });
    expect(cfg.securityHeaders).toMatchObject({
      enabled: true,
      hsts: true,
      nosniff: true,
      frame_deny: true,
      referrer_policy: 'no-referrer',
      custom_headers: { 'X-Sim': 'on' },
    });
  });
});

describe('validateGlobalConfig — fault_rules', () => {
  it('parses a rule and expands the potemkin alias into a header matcher', () => {
    const cfg = validateGlobalConfig({
      fault_rules: [
        {
          name: 'rate-limit',
          match: { condition: 'true', potemkin: { rate_limit: '*' } },
          response: { status: 429, body: { error: 'RATE_LIMITED' }, headers: { 'Retry-After': '30' } },
        },
      ],
    });
    expect(cfg.faults).toHaveLength(1);
    const rule = cfg.faults![0]!;
    expect(rule.response.status).toBe(429);
    // The `potemkin.rate_limit` alias must expand to the concrete header name.
    expect(rule.match.headers).toMatchObject({ 'x-potemkin-rate-limit': '*' });
  });

  it('rejects an unknown potemkin alias', () => {
    expect(() => validateGlobalConfig({
      fault_rules: [
        { name: 'bad', match: { condition: 'true', potemkin: { not_a_real_alias: '*' } }, response: { status: 500 } },
      ],
    })).toThrow(BootError);
  });

  it('reads delay_ms from under response', () => {
    const cfg = validateGlobalConfig({
      fault_rules: [
        { name: 'slow', match: { condition: 'true' }, response: { status: 504, delay_ms: 100 } },
      ],
    });
    expect(cfg.faults![0]!.delay_ms).toBe(100);
  });
});

describe('validateGlobalConfig — auth.jwt.required_claims', () => {
  it('parses required_claims as a Record<string,string>', () => {
    const cfg = validateGlobalConfig({
      auth: {
        mode: 'jwt',
        jwt: {
          secret: 'shhh',
          required_claims: { tenant: 'acme', role: '*' },
        },
      },
    });
    expect(cfg.auth?.jwt?.requiredClaims).toEqual({ tenant: 'acme', role: '*' });
  });

  it('omits requiredClaims when required_claims is absent', () => {
    const cfg = validateGlobalConfig({
      auth: {
        mode: 'jwt',
        jwt: { secret: 'shhh' },
      },
    });
    expect(cfg.auth?.jwt?.requiredClaims).toBeUndefined();
  });

  it('rejects required_claims when the value is not an object', () => {
    expect(() => validateGlobalConfig({
      auth: {
        mode: 'jwt',
        jwt: { secret: 'shhh', required_claims: 'not-an-object' },
      },
    })).toThrow(BootError);
  });

  it('rejects required_claims when a value is not a string', () => {
    expect(() => validateGlobalConfig({
      auth: {
        mode: 'jwt',
        jwt: { secret: 'shhh', required_claims: { tenant: 42 } },
      },
    })).toThrow(BootError);
  });
});

describe('validateGlobalConfig — webhooks', () => {
  it('parses a webhook declaration with trigger, secret, payload and retry', () => {
    const cfg = validateGlobalConfig({
      webhooks: [
        {
          name: 'lead-converted',
          trigger: { boundary: 'LeadConvert', intent: 'mutation', condition: "event.type == 'LeadConverted'" },
          url: "'http://example/webhook'",
          secret: 'shh',
          payload: { leadId: '${event.aggregateId}' },
          retry: { maxAttempts: 2, delayMs: 50 },
        },
      ],
    });
    expect(cfg.webhooks).toHaveLength(1);
    const w = cfg.webhooks![0]!;
    expect(w.name).toBe('lead-converted');
    expect(w.trigger.boundary).toBe('LeadConvert');
    expect(w.secret).toBe('shh');
    expect(w.payload).toMatchObject({ leadId: '${event.aggregateId}' });
    expect(w.retry).toMatchObject({ maxAttempts: 2, delayMs: 50 });
  });

  it('requires a url', () => {
    expect(() => validateGlobalConfig({
      webhooks: [{ name: 'no-url', trigger: { condition: 'true' } }],
    })).toThrow(BootError);
  });
});
