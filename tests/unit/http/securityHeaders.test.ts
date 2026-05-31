/**
 * Unit tests for buildSecurityHeaders — the global security_headers → response
 * header map. Asserts each toggle maps to its canonical header and that the
 * block can be disabled without removing it.
 */

import { buildSecurityHeaders } from '../../../src/http/securityHeaders';

describe('buildSecurityHeaders', () => {
  it('returns an empty map when no config is present', () => {
    expect(buildSecurityHeaders(undefined)).toEqual({});
  });

  it('returns an empty map when explicitly disabled', () => {
    expect(buildSecurityHeaders({ enabled: false, hsts: true, nosniff: true })).toEqual({});
  });

  it('maps each toggle to its canonical header', () => {
    const h = buildSecurityHeaders({
      enabled: true,
      hsts: true,
      nosniff: true,
      frame_deny: true,
      referrer_policy: 'no-referrer',
    });
    expect(h['Strict-Transport-Security']).toContain('max-age=');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['Referrer-Policy']).toBe('no-referrer');
  });

  it('emits custom headers verbatim', () => {
    const h = buildSecurityHeaders({ custom_headers: { 'X-Sim': 'on', 'X-Env': 'test' } });
    expect(h['X-Sim']).toBe('on');
    expect(h['X-Env']).toBe('test');
  });

  it('omits toggles that are not enabled', () => {
    const h = buildSecurityHeaders({ nosniff: true });
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['X-Frame-Options']).toBeUndefined();
    expect(h['Strict-Transport-Security']).toBeUndefined();
  });
});
