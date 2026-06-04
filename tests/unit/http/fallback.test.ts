import { evaluateFallback, isInContract, buildContractMatchers } from '../../../src/http/fallback';
import type { OpenApiDoc } from '../../../src/contract/loader';
import type { FallbackConfig } from '../../../src/dsl/types';

describe('fallback policy', () => {
  describe('evaluateFallback — zero config', () => {
    it('501 for an in-contract path, 404 otherwise', () => {
      expect(evaluateFallback(undefined, { path: '/v1/payouts', method: 'GET', inContract: true }))
        .toEqual({ status: 501, body: { error: 'NOT_IMPLEMENTED', path: '/v1/payouts' } });
      expect(evaluateFallback(undefined, { path: '/nope', method: 'GET', inContract: false }))
        .toEqual({ status: 404, body: { error: 'NO_ROUTE', path: '/nope' } });
    });
  });

  describe('evaluateFallback — rules', () => {
    const cfg: FallbackConfig = {
      rules: [
        { match: { path: '/internal/**' }, respond: { status: 403, body: { error: 'forbidden' } } },
        { match: { method: 'POST', inContract: true }, respond: { status: 501 } },
      ],
      default: { status: 410, body: { error: 'gone' } },
    };

    it('first matching rule wins (path glob)', () => {
      expect(evaluateFallback(cfg, { path: '/internal/secrets', method: 'GET', inContract: false }))
        .toEqual({ status: 403, body: { error: 'forbidden' } });
    });

    it('matches on method + in_contract', () => {
      expect(evaluateFallback(cfg, { path: '/v1/disputes', method: 'POST', inContract: true }).status).toBe(501);
    });

    it('falls to the configured default when no rule matches', () => {
      expect(evaluateFallback(cfg, { path: '/v1/x', method: 'GET', inContract: true }))
        .toEqual({ status: 410, body: { error: 'gone' } });
    });

    it('fills a default body for a bodiless rule response', () => {
      const r = evaluateFallback({ rules: [{ match: {}, respond: { status: 501 } }] }, { path: '/p', method: 'GET', inContract: true });
      expect(r).toEqual({ status: 501, body: { error: 'NOT_IMPLEMENTED', path: '/p' } });
    });
  });

  describe('isInContract', () => {
    const openapi = { paths: { '/v1/customers': {}, '/v1/customers/{customer}': {} } } as unknown as OpenApiDoc;
    const matchers = buildContractMatchers(openapi);
    it('matches templated contract paths', () => {
      expect(isInContract('/v1/customers', matchers)).toBe(true);
      expect(isInContract('/v1/customers/cus_123', matchers)).toBe(true);
      expect(isInContract('/v1/payouts', matchers)).toBe(false);
    });
  });
});
