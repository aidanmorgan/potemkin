import { resolveChaosHeaders, truncateBody } from '../../../src/http/chaosHeaders';
import type { FaultRule } from '../../../src/dsl/types';
import {
  POTEMKIN_USE_FAULT,
  POTEMKIN_FORCE_STATUS,
  POTEMKIN_ERROR_CLASS,
  POTEMKIN_DROP_CONNECTION,
  POTEMKIN_SUCCESS_RATE,
  POTEMKIN_FORCE_LATENCY,
  POTEMKIN_SLOW_RESPONSE,
  POTEMKIN_JITTER,
  POTEMKIN_BODY_TRUNCATE,
  POTEMKIN_RETRY_AFTER,
} from '../../../src/http/potemkinHeaders';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRule(name: string, headerName: string, headerValue: string, status: number): FaultRule {
  return {
    name,
    match: {
      condition: 'true',
      headers: { [headerName]: headerValue },
    },
    response: { status, body: { rule: name } },
  };
}

function makeNamedRule(name: string, status: number): FaultRule {
  return {
    name,
    match: { condition: 'true' },
    response: { status, body: { rule: name } },
  };
}

// ── truncateBody ─────────────────────────────────────────────────────────────

describe('truncateBody', () => {
  it('returns empty string when maxBytes is zero', () => {
    expect(truncateBody({ key: 'value' }, 0)).toBe('');
  });

  it('returns empty string when maxBytes is negative', () => {
    expect(truncateBody({ key: 'value' }, -1)).toBe('');
  });

  it('returns original body object when serialised length is within limit', () => {
    const body = { a: 1 };
    const result = truncateBody(body, JSON.stringify(body).length); // '{"a":1}' = 7 chars, exactly at limit
    expect(result).toBe(body);
  });

  it('returns original body when limit exceeds serialised length', () => {
    const body = { hello: 'world' };
    const result = truncateBody(body, 9999);
    expect(result).toBe(body);
  });

  it('truncates by character count (slice of JSON string) when body exceeds limit', () => {
    const body = { message: 'hello world' };
    const serialised = JSON.stringify(body); // '{"message":"hello world"}'
    const limit = 10;
    const result = truncateBody(body, limit);
    expect(typeof result).toBe('string');
    expect((result as string).length).toBe(limit);
    expect(result).toBe(serialised.slice(0, limit));
  });

  it('truncates exactly to the byte (char) limit', () => {
    const body = 'abcdefghij';
    const serialised = JSON.stringify(body); // '"abcdefghij"' = 12 chars
    const result = truncateBody(body, 5);
    expect(result).toBe(serialised.slice(0, 5));
  });

  it('handles null body at limit', () => {
    // JSON.stringify(null) === 'null' = 4 chars; at exactly 4 the original is returned
    expect(truncateBody(null, 4)).toBe(null);
    // below the limit, returns the sliced string
    expect(truncateBody(null, 3)).toBe('nul');
  });
});

// ── parseJitter (tested via resolveChaosHeaders) ─────────────────────────────

describe('parseJitter (via resolveChaosHeaders)', () => {
  it('single integer form adds latency in [0, max]', () => {
    const result = resolveChaosHeaders({ [POTEMKIN_JITTER]: '200' }, []);
    expect(result.extraLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.extraLatencyMs).toBeLessThanOrEqual(200);
  });

  it('min:max form adds latency in [min, max]', () => {
    const results: number[] = [];
    for (let i = 0; i < 30; i++) {
      const r = resolveChaosHeaders({ [POTEMKIN_JITTER]: '100:300' }, []);
      results.push(r.extraLatencyMs);
    }
    for (const ms of results) {
      expect(ms).toBeGreaterThanOrEqual(100);
      expect(ms).toBeLessThanOrEqual(300);
    }
  });

  it('zero-only jitter ("0") adds exactly 0', () => {
    const result = resolveChaosHeaders({ [POTEMKIN_JITTER]: '0' }, []);
    expect(result.extraLatencyMs).toBe(0);
  });

  it('min=max jitter ("150:150") adds exactly that value', () => {
    const result = resolveChaosHeaders({ [POTEMKIN_JITTER]: '150:150' }, []);
    expect(result.extraLatencyMs).toBe(150);
  });

  it('malformed jitter (no colon, non-numeric) produces zero extra latency', () => {
    const result = resolveChaosHeaders({ [POTEMKIN_JITTER]: 'banana' }, []);
    expect(result.extraLatencyMs).toBe(0);
  });

  it('":100" (empty lo) is parsed as [0, 100] because Number("") === 0', () => {
    // Number('') === 0, so ':100' → lo=0, hi=100, valid [0, 100] range
    const result = resolveChaosHeaders({ [POTEMKIN_JITTER]: ':100' }, []);
    expect(result.extraLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.extraLatencyMs).toBeLessThanOrEqual(100);
  });

  it('min > max jitter is rejected and produces zero extra latency', () => {
    const result = resolveChaosHeaders({ [POTEMKIN_JITTER]: '500:100' }, []);
    expect(result.extraLatencyMs).toBe(0);
  });

  it('negative single value is rejected and produces zero extra latency', () => {
    const result = resolveChaosHeaders({ [POTEMKIN_JITTER]: '-50' }, []);
    expect(result.extraLatencyMs).toBe(0);
  });
});

// ── parseSuccessRate (tested via resolveChaosHeaders) ───────────────────────

describe('parseSuccessRate (via resolveChaosHeaders)', () => {
  it('rate of 1.0 always succeeds (threshold is met, random < 1)', () => {
    for (let i = 0; i < 20; i++) {
      const r = resolveChaosHeaders({ [POTEMKIN_SUCCESS_RATE]: '1' }, []);
      expect(r.response).toBeUndefined();
    }
  });

  it('rate of 0 always fails with 503', () => {
    for (let i = 0; i < 10; i++) {
      const r = resolveChaosHeaders({ [POTEMKIN_SUCCESS_RATE]: '0' }, []);
      expect(r.response?.status).toBe(503);
    }
  });

  it('0..1 form "0.8" is accepted as-is (80% success)', () => {
    const results = Array.from({ length: 100 }, () =>
      resolveChaosHeaders({ [POTEMKIN_SUCCESS_RATE]: '0.8' }, []),
    );
    const failures = results.filter(r => r.response !== undefined);
    expect(failures.length).toBeGreaterThanOrEqual(0);
    expect(failures.length).toBeLessThan(100);
    if (failures.length > 0) {
      expect(failures[0].response?.status).toBe(503);
    }
  });

  it('100-scale form "100" maps to success rate 1.0 (always succeeds)', () => {
    for (let i = 0; i < 20; i++) {
      const r = resolveChaosHeaders({ [POTEMKIN_SUCCESS_RATE]: '100' }, []);
      expect(r.response).toBeUndefined();
    }
  });

  it('100-scale form "0" maps to 0 success rate (always fails)', () => {
    for (let i = 0; i < 10; i++) {
      const r = resolveChaosHeaders({ [POTEMKIN_SUCCESS_RATE]: '0' }, []);
      expect(r.response?.status).toBe(503);
    }
  });

  it('out-of-range value >100 produces no response (ignored)', () => {
    const r = resolveChaosHeaders({ [POTEMKIN_SUCCESS_RATE]: '101' }, []);
    expect(r.response).toBeUndefined();
  });

  it('negative value is rejected (no response)', () => {
    const r = resolveChaosHeaders({ [POTEMKIN_SUCCESS_RATE]: '-5' }, []);
    expect(r.response).toBeUndefined();
  });

  it('non-numeric value is rejected (no response)', () => {
    const r = resolveChaosHeaders({ [POTEMKIN_SUCCESS_RATE]: 'high' }, []);
    expect(r.response).toBeUndefined();
  });

  it('failure response includes SUCCESS_RATE_GATE error code', () => {
    const r = resolveChaosHeaders({ [POTEMKIN_SUCCESS_RATE]: '0' }, []);
    expect((r.response?.body as Record<string, unknown>)?.error).toBe('SUCCESS_RATE_GATE');
  });
});

// ── findRuleByHeader (tested via resolveChaosHeaders) ───────────────────────

describe('findRuleByHeader (via resolveChaosHeaders)', () => {
  it('wildcard "*" matches any value sent in the header', () => {
    const rule = makeRule('wildcard-force-status', POTEMKIN_FORCE_STATUS, '*', 418);
    const r = resolveChaosHeaders({ [POTEMKIN_FORCE_STATUS]: '503' }, [rule]);
    expect(r.response?.status).toBe(418);
    expect(r.matchedRuleName).toBe('wildcard-force-status');
  });

  it('exact value match returns the matching rule', () => {
    const rule = makeRule('exact-force-status', POTEMKIN_FORCE_STATUS, '503', 418);
    const r = resolveChaosHeaders({ [POTEMKIN_FORCE_STATUS]: '503' }, [rule]);
    expect(r.response?.status).toBe(418);
    expect(r.matchedRuleName).toBe('exact-force-status');
  });

  it('exact value miss does NOT match (uses generic fallback instead)', () => {
    const rule = makeRule('exact-force-status', POTEMKIN_FORCE_STATUS, '429', 418);
    const r = resolveChaosHeaders({ [POTEMKIN_FORCE_STATUS]: '503' }, [rule]);
    expect(r.response?.status).toBe(503);
    expect(r.matchedRuleName).toBeUndefined();
  });

  it('first matching rule wins when multiple rules match', () => {
    const ruleA = makeRule('first', POTEMKIN_FORCE_STATUS, '*', 400);
    const ruleB = makeRule('second', POTEMKIN_FORCE_STATUS, '*', 418);
    const r = resolveChaosHeaders({ [POTEMKIN_FORCE_STATUS]: '503' }, [ruleA, ruleB]);
    expect(r.matchedRuleName).toBe('first');
    expect(r.response?.status).toBe(400);
  });

  it('rule without match.headers is skipped in header-based lookup', () => {
    const rule = makeNamedRule('no-headers-rule', 418);
    const r = resolveChaosHeaders({ [POTEMKIN_FORCE_STATUS]: '503' }, [rule]);
    expect(r.response?.status).toBe(503);
    expect(r.matchedRuleName).toBeUndefined();
  });
});

// ── Precedence: Use-Fault > Force-Status > Error-Class > Drop-Connection > Success-Rate

describe('resolveChaosHeaders — precedence ladder', () => {
  describe('Use-Fault wins over Force-Status', () => {
    it('resolves named fault rule response, ignores Force-Status', () => {
      const faultRule = makeNamedRule('my-fault', 418);
      const r = resolveChaosHeaders(
        {
          [POTEMKIN_USE_FAULT]: 'my-fault',
          [POTEMKIN_FORCE_STATUS]: '503',
        },
        [faultRule],
      );
      expect(r.response?.status).toBe(418);
      expect(r.matchedRuleName).toBe('my-fault');
    });

    it('Use-Fault with a matching named rule sets matchedRuleName', () => {
      const faultRule = makeNamedRule('chaos-rule', 504);
      const r = resolveChaosHeaders({ [POTEMKIN_USE_FAULT]: 'chaos-rule' }, [faultRule]);
      expect(r.matchedRuleName).toBe('chaos-rule');
      expect(r.response?.status).toBe(504);
    });

    it('Use-Fault with unknown rule name produces no response', () => {
      const faultRule = makeNamedRule('real-rule', 418);
      const r = resolveChaosHeaders({ [POTEMKIN_USE_FAULT]: 'nonexistent-rule' }, [faultRule]);
      expect(r.response).toBeUndefined();
    });
  });

  describe('Use-Fault wins over Error-Class', () => {
    it('named fault response takes precedence over Error-Class mapping', () => {
      const faultRule = makeNamedRule('my-fault', 400);
      const r = resolveChaosHeaders(
        {
          [POTEMKIN_USE_FAULT]: 'my-fault',
          [POTEMKIN_ERROR_CLASS]: 'timeout',
        },
        [faultRule],
      );
      expect(r.response?.status).toBe(400);
      expect(r.matchedRuleName).toBe('my-fault');
    });
  });

  describe('Force-Status wins over Error-Class', () => {
    it('resolves Force-Status generic response, ignores Error-Class', () => {
      const r = resolveChaosHeaders(
        {
          [POTEMKIN_FORCE_STATUS]: '429',
          [POTEMKIN_ERROR_CLASS]: 'timeout',
        },
        [],
      );
      expect(r.response?.status).toBe(429);
      expect((r.response?.body as Record<string, unknown>)?.error).toBe('FORCED_STATUS');
    });
  });

  describe('Force-Status generic fallback', () => {
    it('produces FORCED_STATUS body with the requested status code', () => {
      const r = resolveChaosHeaders({ [POTEMKIN_FORCE_STATUS]: '422' }, []);
      expect(r.response?.status).toBe(422);
      expect((r.response?.body as Record<string, unknown>)?.error).toBe('FORCED_STATUS');
      expect((r.response?.body as Record<string, unknown>)?.status).toBe(422);
    });

    it('rejects out-of-range status codes (no response)', () => {
      const r = resolveChaosHeaders({ [POTEMKIN_FORCE_STATUS]: '99' }, []);
      expect(r.response).toBeUndefined();
    });

    it('rejects out-of-range status codes above 599 (no response)', () => {
      const r = resolveChaosHeaders({ [POTEMKIN_FORCE_STATUS]: '600' }, []);
      expect(r.response).toBeUndefined();
    });

    it('rejects non-integer status (no response)', () => {
      const r = resolveChaosHeaders({ [POTEMKIN_FORCE_STATUS]: '4.5' }, []);
      expect(r.response).toBeUndefined();
    });
  });

  describe('Error-Class canonical mappings', () => {
    const cases: Array<[string, number, string]> = [
      ['timeout',     504, 'GATEWAY_TIMEOUT'],
      ['throttle',    429, 'TOO_MANY_REQUESTS'],
      ['outage',      503, 'SERVICE_UNAVAILABLE'],
      ['bad_gateway', 502, 'BAD_GATEWAY'],
      ['conflict',    409, 'CONFLICT'],
      ['auth',        401, 'UNAUTHENTICATED'],
      ['forbidden',   403, 'FORBIDDEN'],
    ];
    it.each(cases)('class "%s" maps to status %d and error %s', (cls, status, error) => {
      const r = resolveChaosHeaders({ [POTEMKIN_ERROR_CLASS]: cls }, []);
      expect(r.response?.status).toBe(status);
      expect((r.response?.body as Record<string, unknown>)?.error).toBe(error);
    });

    it('unknown error class produces no response', () => {
      const r = resolveChaosHeaders({ [POTEMKIN_ERROR_CLASS]: 'unknown_class' }, []);
      expect(r.response).toBeUndefined();
    });
  });

  describe('Drop-Connection', () => {
    it('sets dropConnection=true and accumulates latency', () => {
      const r = resolveChaosHeaders({ [POTEMKIN_DROP_CONNECTION]: '500' }, []);
      expect(r.dropConnection).toBe(true);
      expect(r.extraLatencyMs).toBe(500);
      expect(r.response).toBeUndefined();
    });

    it('caps drop-connection latency at 30 000 ms', () => {
      const r = resolveChaosHeaders({ [POTEMKIN_DROP_CONNECTION]: '99999' }, []);
      expect(r.dropConnection).toBe(true);
      expect(r.extraLatencyMs).toBe(30_000);
    });

    it('is skipped when a higher-priority header already resolved a response', () => {
      const r = resolveChaosHeaders(
        { [POTEMKIN_FORCE_STATUS]: '503', [POTEMKIN_DROP_CONNECTION]: '500' },
        [],
      );
      expect(r.dropConnection).toBeUndefined();
      expect(r.response?.status).toBe(503);
    });
  });

  describe('Success-Rate gate', () => {
    it('is skipped when dropConnection is true (Drop-Connection takes precedence)', () => {
      const r = resolveChaosHeaders(
        { [POTEMKIN_DROP_CONNECTION]: '0', [POTEMKIN_SUCCESS_RATE]: '0' },
        [],
      );
      expect(r.dropConnection).toBe(true);
      expect(r.response).toBeUndefined();
    });
  });
});

// ── Latency headers stack additively ─────────────────────────────────────────

describe('resolveChaosHeaders — latency stacking', () => {
  it('Force-Latency adds to extraLatencyMs', () => {
    const r = resolveChaosHeaders({ [POTEMKIN_FORCE_LATENCY]: '300' }, []);
    expect(r.extraLatencyMs).toBe(300);
  });

  it('Slow-Response adds to extraLatencyMs', () => {
    const r = resolveChaosHeaders({ [POTEMKIN_SLOW_RESPONSE]: '250' }, []);
    expect(r.extraLatencyMs).toBe(250);
  });

  it('Force-Latency and Slow-Response stack additively', () => {
    const r = resolveChaosHeaders(
      { [POTEMKIN_FORCE_LATENCY]: '200', [POTEMKIN_SLOW_RESPONSE]: '150' },
      [],
    );
    expect(r.extraLatencyMs).toBe(350);
  });

  it('Force-Latency and Jitter stack additively', () => {
    const r = resolveChaosHeaders(
      { [POTEMKIN_FORCE_LATENCY]: '500', [POTEMKIN_JITTER]: '0' },
      [],
    );
    expect(r.extraLatencyMs).toBe(500);
  });

  it('individual latency values are capped at 30 000 ms each', () => {
    const r = resolveChaosHeaders({ [POTEMKIN_FORCE_LATENCY]: '99999' }, []);
    expect(r.extraLatencyMs).toBe(30_000);
  });

  it('latency headers still apply even when a chaos response is resolved', () => {
    const r = resolveChaosHeaders(
      { [POTEMKIN_ERROR_CLASS]: 'timeout', [POTEMKIN_FORCE_LATENCY]: '200' },
      [],
    );
    expect(r.response?.status).toBe(504);
    expect(r.extraLatencyMs).toBe(200);
  });
});

// ── Body-Truncate header ──────────────────────────────────────────────────────

describe('resolveChaosHeaders — Body-Truncate', () => {
  it('sets bodyTruncateBytes when a valid integer is provided', () => {
    const r = resolveChaosHeaders({ [POTEMKIN_BODY_TRUNCATE]: '128' }, []);
    expect(r.bodyTruncateBytes).toBe(128);
  });

  it('sets bodyTruncateBytes to 0 (a valid integer)', () => {
    const r = resolveChaosHeaders({ [POTEMKIN_BODY_TRUNCATE]: '0' }, []);
    expect(r.bodyTruncateBytes).toBe(0);
  });

  it('rejects non-integer truncate values (no bodyTruncateBytes)', () => {
    const r = resolveChaosHeaders({ [POTEMKIN_BODY_TRUNCATE]: '3.5' }, []);
    expect(r.bodyTruncateBytes).toBeUndefined();
  });

  it('bodyTruncateBytes is present alongside a chaos response', () => {
    const r = resolveChaosHeaders(
      { [POTEMKIN_FORCE_STATUS]: '500', [POTEMKIN_BODY_TRUNCATE]: '64' },
      [],
    );
    expect(r.response?.status).toBe(500);
    expect(r.bodyTruncateBytes).toBe(64);
  });
});

// ── Retry-After merging ───────────────────────────────────────────────────────

describe('resolveChaosHeaders — Retry-After', () => {
  it('attaches Retry-After header to a chaos response when valid', () => {
    const r = resolveChaosHeaders(
      { [POTEMKIN_FORCE_STATUS]: '429', [POTEMKIN_RETRY_AFTER]: '30' },
      [],
    );
    expect(r.response?.headers?.['Retry-After']).toBe('30');
  });

  it('floors fractional Retry-After seconds', () => {
    const r = resolveChaosHeaders(
      { [POTEMKIN_FORCE_STATUS]: '429', [POTEMKIN_RETRY_AFTER]: '5.9' },
      [],
    );
    expect(r.response?.headers?.['Retry-After']).toBe('5');
  });

  it('does not attach Retry-After when no chaos response is triggered', () => {
    const r = resolveChaosHeaders({ [POTEMKIN_RETRY_AFTER]: '10' }, []);
    expect(r.response).toBeUndefined();
  });

  it('ignores negative Retry-After (treated as invalid)', () => {
    const r = resolveChaosHeaders(
      { [POTEMKIN_FORCE_STATUS]: '503', [POTEMKIN_RETRY_AFTER]: '-5' },
      [],
    );
    expect(r.response?.headers?.['Retry-After']).toBeUndefined();
  });
});

// ── No headers — clean baseline ───────────────────────────────────────────────

describe('resolveChaosHeaders — baseline (no chaos headers)', () => {
  it('returns zero extraLatencyMs and no response when no headers are present', () => {
    const r = resolveChaosHeaders({}, []);
    expect(r.extraLatencyMs).toBe(0);
    expect(r.response).toBeUndefined();
    expect(r.dropConnection).toBeUndefined();
    expect(r.bodyTruncateBytes).toBeUndefined();
  });

  it('handles undefined headers map gracefully', () => {
    const r = resolveChaosHeaders(undefined, []);
    expect(r.extraLatencyMs).toBe(0);
    expect(r.response).toBeUndefined();
  });

  it('reads first value from array-valued headers', () => {
    const r = resolveChaosHeaders(
      { [POTEMKIN_FORCE_STATUS]: ['503', '200'] },
      [],
    );
    expect(r.response?.status).toBe(503);
  });
});

// ── Boundary vs global fault rule resolution ──────────────────────────────────

describe('resolveChaosHeaders — boundary vs global fault rules', () => {
  it('uses the response from the first matching boundary rule when present', () => {
    const boundaryRule = makeRule('boundary-rule', POTEMKIN_FORCE_STATUS, '503', 418);
    const globalRule   = makeRule('global-rule',   POTEMKIN_FORCE_STATUS, '503', 500);
    const r = resolveChaosHeaders(
      { [POTEMKIN_FORCE_STATUS]: '503' },
      [boundaryRule, globalRule],
    );
    expect(r.matchedRuleName).toBe('boundary-rule');
    expect(r.response?.status).toBe(418);
  });

  it('falls back to generic behaviour when neither boundary nor global rules match', () => {
    const r = resolveChaosHeaders({ [POTEMKIN_FORCE_STATUS]: '503' }, []);
    expect(r.response?.status).toBe(503);
    expect((r.response?.body as Record<string, unknown>)?.error).toBe('FORCED_STATUS');
    expect(r.matchedRuleName).toBeUndefined();
  });
});
