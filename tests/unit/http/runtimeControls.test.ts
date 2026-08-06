import { controlsFromHeaders } from '../../../src/http/runtimeControls.js';
import { MAX_RUNTIME_DELAY_MS, normalizeRuntimeControls } from '../../../src/model/runtime.js';

describe('runtime control header parsing', () => {
  it('accepts single-value and ordered jitter ranges', () => {
    expect(controlsFromHeaders({ 'x-potemkin-jitter': '150' }).jitterMs).toEqual({
      min: 0,
      max: 150,
    });
    expect(controlsFromHeaders({ 'x-potemkin-jitter': '20:150' }).jitterMs).toEqual({
      min: 20,
      max: 150,
    });
  });

  it('ignores malformed, reversed, and over-limit jitter ranges', () => {
    for (const value of [
      '150:20',
      '-1:20',
      '20:-1',
      '20:30:40',
      '20:',
      ':20',
      ':',
      '30:40000',
      'nope',
    ]) {
      expect(controlsFromHeaders({ 'x-potemkin-jitter': value }).jitterMs).toBeUndefined();
    }
  });

  it('bounds request-driven fixed delays at the documented limit', () => {
    expect(
      controlsFromHeaders({
        'x-potemkin-force-latency': String(MAX_RUNTIME_DELAY_MS),
        'x-potemkin-slow-response': '10',
      }).forceLatencyMs,
    ).toBe(MAX_RUNTIME_DELAY_MS);
    expect(
      controlsFromHeaders({ 'x-potemkin-force-latency': String(MAX_RUNTIME_DELAY_MS + 1) })
        .forceLatencyMs,
    ).toBeUndefined();
    expect(
      controlsFromHeaders({ 'x-potemkin-drop-connection': String(MAX_RUNTIME_DELAY_MS + 1) })
        .dropConnectionMs,
    ).toBeUndefined();
  });

  it('preserves unrelated control parsing while normalizing chaos controls', () => {
    expect(
      controlsFromHeaders({
        'x-potemkin-force-status': '418',
        'x-potemkin-error-class': 'CONFLICT',
        'x-potemkin-success-rate': '25',
        'x-potemkin-retry-after': '3',
        'x-potemkin-body-truncate': '12.9',
      }),
    ).toMatchObject({
      forceStatus: 418,
      errorClass: 'conflict',
      successRate: 0.25,
      retryAfterSeconds: 3,
      bodyTruncateBytes: 12,
    });
  });

  it('applies the same bounds to direct typed runtime controls', () => {
    const normalized = normalizeRuntimeControls({
      forceLatencyMs: MAX_RUNTIME_DELAY_MS + 1,
      dropConnectionMs: -1,
      jitterMs: { min: 20, max: 10 },
      successRate: 0.5,
    });

    expect(normalized).toEqual({ successRate: 0.5 });
  });

  it('maps every optional transport control and handles array-valued headers', () => {
    expect(
      controlsFromHeaders({
        'X-Potemkin-Use-Fault': ['maintenance'],
        'x-potemkin-feature-flag': 'new-checkout',
        'x-potemkin-rate-limit': 'off',
        'x-potemkin-signal': '  DEGRADED ',
        'x-potemkin-force-response': 'maintenance',
        'x-potemkin-scenario': 'slow-db',
        'x-potemkin-force-status': '418.9',
        'x-potemkin-error-class': 'FORBIDDEN',
        'x-potemkin-retry-after': '4',
        'x-potemkin-body-truncate': '10.9',
        'x-potemkin-force-latency': '20',
        'x-potemkin-slow-response': '30',
        'x-potemkin-success-rate': '100',
      }),
    ).toMatchObject({
      useFault: 'maintenance',
      featureFlag: 'new-checkout',
      rateLimit: false,
      signal: 'degraded',
      forceResponse: 'maintenance',
      scenario: 'slow-db',
      forceStatus: 418,
      errorClass: 'forbidden',
      forceLatencyMs: 50,
      successRate: 1,
      retryAfterSeconds: 4,
      bodyTruncateBytes: 10,
    });
  });

  it('ignores invalid scalar controls and preserves layered defaults', () => {
    expect(
      controlsFromHeaders(
        {
          'x-potemkin-success-rate': '101',
          'x-potemkin-error-class': 'unknown',
          'x-potemkin-retry-after': '-1',
          'x-potemkin-body-truncate': 'nope',
          'x-potemkin-force-status': '-2',
        },
        { transparency: { echo: true }, chaos: { successRate: 0.25 } },
      ),
    ).toMatchObject({ echo: true, successRate: 0.25 });
  });
});
