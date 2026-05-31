import {
  parseControlHeaders, requiresAdminAuth, applyMask,
} from '../../../src/http/controlHeaders';

describe('parseControlHeaders', () => {
  it('returns all-undefined tiers when no headers are present', () => {
    const c = parseControlHeaders({});
    expect(c.transparency).toEqual({});
    expect(c.sideEffects).toEqual({});
    expect(c.identity).toEqual({});
    expect(c.timeTravel).toEqual({});
    expect(c.format).toEqual({});
    expect(c.observability).toEqual({});
    expect(c.validation).toEqual({});
  });

  describe('Tier 1 — transparency', () => {
    it('parses dry-run as boolean across canonical forms', () => {
      for (const truthy of ['true', '1', 'yes', 'on', 'TRUE', 'YES']) {
        expect(parseControlHeaders({ 'x-potemkin-dry-run': truthy }).transparency.dryRun).toBe(true);
      }
      for (const falsy of ['false', '0', 'no', 'off']) {
        expect(parseControlHeaders({ 'x-potemkin-dry-run': falsy }).transparency.dryRun).toBe(false);
      }
    });

    it('parses include-events and echo independently', () => {
      const c = parseControlHeaders({
        'x-potemkin-include-events': 'true',
        'x-potemkin-echo': 'true',
      });
      expect(c.transparency.includeEvents).toBe(true);
      expect(c.transparency.echo).toBe(true);
    });

    it('captures seed as raw string', () => {
      const c = parseControlHeaders({ 'x-potemkin-seed': 'my-seed-42' });
      expect(c.transparency.seed).toBe('my-seed-42');
    });

    it('parses clock-offset as signed integer', () => {
      expect(parseControlHeaders({ 'x-potemkin-clock-offset': '3600000' })
        .transparency.clockOffsetMs).toBe(3600000);
      expect(parseControlHeaders({ 'x-potemkin-clock-offset': '-500' })
        .transparency.clockOffsetMs).toBe(-500);
    });

    it('rejects non-integer clock-offset', () => {
      expect(parseControlHeaders({ 'x-potemkin-clock-offset': '3.5' })
        .transparency.clockOffsetMs).toBeUndefined();
      expect(parseControlHeaders({ 'x-potemkin-clock-offset': 'banana' })
        .transparency.clockOffsetMs).toBeUndefined();
    });
  });

  describe('Tier 2 — side effects', () => {
    it('parses all skip-* flags as booleans', () => {
      const c = parseControlHeaders({
        'x-potemkin-skip-sagas': 'true',
        'x-potemkin-skip-webhooks': 'true',
        'x-potemkin-skip-projections': 'true',
        'x-potemkin-skip-dispatch': 'true',
      });
      expect(c.sideEffects.skipSagas).toBe(true);
      expect(c.sideEffects.skipWebhooks).toBe(true);
      expect(c.sideEffects.skipProjections).toBe(true);
      expect(c.sideEffects.skipDispatch).toBe(true);
    });

    it('parses max-cascade-depth as non-negative integer', () => {
      expect(parseControlHeaders({ 'x-potemkin-max-cascade-depth': '3' })
        .sideEffects.maxCascadeDepth).toBe(3);
      expect(parseControlHeaders({ 'x-potemkin-max-cascade-depth': '0' })
        .sideEffects.maxCascadeDepth).toBe(0);
      expect(parseControlHeaders({ 'x-potemkin-max-cascade-depth': '-1' })
        .sideEffects.maxCascadeDepth).toBeUndefined();
    });

    it('parses bulk-transactional flag', () => {
      expect(parseControlHeaders({ 'x-potemkin-bulk-transactional': 'true' })
        .sideEffects.bulkTransactional).toBe(true);
    });
  });

  describe('Tier 3 — identity', () => {
    it('captures actor override, caused-by, and impersonate as raw strings', () => {
      const c = parseControlHeaders({
        'x-potemkin-actor': 'alice:admin,trader',
        'x-potemkin-caused-by': '01234567-89ab-cdef-0123-456789abcdef',
        'x-potemkin-impersonate': 'bob',
      });
      expect(c.identity.actorOverride).toBe('alice:admin,trader');
      expect(c.identity.causedBy).toBe('01234567-89ab-cdef-0123-456789abcdef');
      expect(c.identity.impersonate).toBe('bob');
    });
  });

  describe('Tier 4 — time travel', () => {
    it('parses read-at-version as non-negative integer', () => {
      expect(parseControlHeaders({ 'x-potemkin-read-at-version': '5' })
        .timeTravel.readAtVersion).toBe(5);
      expect(parseControlHeaders({ 'x-potemkin-read-at-version': '0' })
        .timeTravel.readAtVersion).toBe(0);
    });

    it('captures replay-event id as raw string', () => {
      const c = parseControlHeaders({ 'x-potemkin-replay-event': 'evt-123' });
      expect(c.timeTravel.replayEvent).toBe('evt-123');
    });
  });

  describe('Tier 5 — format', () => {
    it('accepts only valid response-format values', () => {
      expect(parseControlHeaders({ 'x-potemkin-response-format': 'hal' })
        .format.responseFormat).toBe('hal');
      expect(parseControlHeaders({ 'x-potemkin-response-format': 'jsonapi' })
        .format.responseFormat).toBe('jsonapi');
      expect(parseControlHeaders({ 'x-potemkin-response-format': 'plain' })
        .format.responseFormat).toBe('plain');
      expect(parseControlHeaders({ 'x-potemkin-response-format': 'xml' })
        .format.responseFormat).toBeUndefined();
    });

    it('accepts only valid pagination-style values', () => {
      expect(parseControlHeaders({ 'x-potemkin-pagination-style': 'envelope' })
        .format.paginationStyle).toBe('envelope');
      expect(parseControlHeaders({ 'x-potemkin-pagination-style': 'raw' })
        .format.paginationStyle).toBe('raw');
      expect(parseControlHeaders({ 'x-potemkin-pagination-style': 'link-header' })
        .format.paginationStyle).toBe('link-header');
      expect(parseControlHeaders({ 'x-potemkin-pagination-style': 'weird' })
        .format.paginationStyle).toBeUndefined();
    });

    it('parses mask as CSV array of field names', () => {
      expect(parseControlHeaders({ 'x-potemkin-mask': 'email,phone,ssn' })
        .format.maskFields).toEqual(['email', 'phone', 'ssn']);
      expect(parseControlHeaders({ 'x-potemkin-mask': ' email , phone ' })
        .format.maskFields).toEqual(['email', 'phone']);
    });
  });

  describe('Tier 6 — observability', () => {
    it('captures trace-id and span-name as raw strings', () => {
      const c = parseControlHeaders({
        'x-potemkin-trace-id': '0123456789abcdef',
        'x-potemkin-span-name': 'custom-span',
      });
      expect(c.observability.traceId).toBe('0123456789abcdef');
      expect(c.observability.spanName).toBe('custom-span');
    });

    it('accepts only valid log levels', () => {
      for (const lvl of ['debug', 'info', 'warn', 'error']) {
        expect(parseControlHeaders({ 'x-potemkin-log-level': lvl })
          .observability.logLevel).toBe(lvl);
      }
      expect(parseControlHeaders({ 'x-potemkin-log-level': 'verbose' })
        .observability.logLevel).toBeUndefined();
    });

    it('parses metric-tag as key=value pairs', () => {
      const c = parseControlHeaders({ 'x-potemkin-metric-tag': 'tenant=acme' });
      expect(c.observability.metricTag).toEqual({ key: 'tenant', value: 'acme' });
    });

    it('rejects malformed metric-tag', () => {
      expect(parseControlHeaders({ 'x-potemkin-metric-tag': 'no-equals' })
        .observability.metricTag).toBeUndefined();
      expect(parseControlHeaders({ 'x-potemkin-metric-tag': '=no-key' })
        .observability.metricTag).toBeUndefined();
    });
  });

  describe('Tier 7 — validation control', () => {
    it('parses all skip-validation flags as booleans', () => {
      const c = parseControlHeaders({
        'x-potemkin-skip-request-validation': 'true',
        'x-potemkin-skip-response-validation': 'true',
        'x-potemkin-allow-additional-properties': 'true',
      });
      expect(c.validation.skipRequestValidation).toBe(true);
      expect(c.validation.skipResponseValidation).toBe(true);
      expect(c.validation.allowAdditionalProperties).toBe(true);
    });
  });

  describe('cross-tier independence', () => {
    it('parses headers from multiple tiers in one request', () => {
      const c = parseControlHeaders({
        'x-potemkin-dry-run': 'true',
        'x-potemkin-skip-sagas': 'true',
        'x-potemkin-actor': 'alice:admin',
        'x-potemkin-read-at-version': '5',
        'x-potemkin-response-format': 'hal',
        'x-potemkin-trace-id': 'trace-abc',
        'x-potemkin-skip-request-validation': 'true',
      });
      expect(c.transparency.dryRun).toBe(true);
      expect(c.sideEffects.skipSagas).toBe(true);
      expect(c.identity.actorOverride).toBe('alice:admin');
      expect(c.timeTravel.readAtVersion).toBe(5);
      expect(c.format.responseFormat).toBe('hal');
      expect(c.observability.traceId).toBe('trace-abc');
      expect(c.validation.skipRequestValidation).toBe(true);
    });

    it('handles array-valued headers by taking the first', () => {
      const c = parseControlHeaders({ 'x-potemkin-seed': ['first', 'second'] });
      expect(c.transparency.seed).toBe('first');
    });
  });
});

describe('requiresAdminAuth', () => {
  it('returns true when any validation override is set', () => {
    expect(requiresAdminAuth(parseControlHeaders({
      'x-potemkin-skip-request-validation': 'true',
    }))).toBe(true);
    expect(requiresAdminAuth(parseControlHeaders({
      'x-potemkin-skip-response-validation': 'true',
    }))).toBe(true);
    expect(requiresAdminAuth(parseControlHeaders({
      'x-potemkin-allow-additional-properties': 'true',
    }))).toBe(true);
  });

  it('returns true when actor-override or impersonation is set', () => {
    expect(requiresAdminAuth(parseControlHeaders({
      'x-potemkin-actor': 'alice:admin',
    }))).toBe(true);
    expect(requiresAdminAuth(parseControlHeaders({
      'x-potemkin-impersonate': 'bob',
    }))).toBe(true);
  });

  it('returns false for harmless controls', () => {
    expect(requiresAdminAuth(parseControlHeaders({
      'x-potemkin-dry-run': 'true',
      'x-potemkin-echo': 'true',
      'x-potemkin-skip-sagas': 'true',
      'x-potemkin-trace-id': 'abc',
    }))).toBe(false);
  });

  it('returns false on an empty header set', () => {
    expect(requiresAdminAuth(parseControlHeaders({}))).toBe(false);
  });
});

describe('applyMask', () => {
  it('replaces top-level fields with [MASKED]', () => {
    const masked = applyMask({ name: 'Alice', email: 'a@b.com', phone: '555-0100' }, ['email', 'phone']);
    expect(masked).toEqual({ name: 'Alice', email: '[MASKED]', phone: '[MASKED]' });
  });

  it('recurses into arrays', () => {
    const masked = applyMask(
      [{ email: 'a@b.com' }, { email: 'c@d.com' }],
      ['email'],
    );
    expect(masked).toEqual([{ email: '[MASKED]' }, { email: '[MASKED]' }]);
  });

  it('recurses into nested objects', () => {
    const masked = applyMask(
      { items: [{ email: 'a@b.com' }, { email: 'c@d.com' }] },
      ['email'],
    );
    expect((masked as { items: Array<{ email: string }> }).items[0].email).toBe('[MASKED]');
  });

  it('is a no-op when field list is empty', () => {
    const original = { email: 'a@b.com' };
    expect(applyMask(original, [])).toBe(original);
  });

  it('ignores fields that are not present', () => {
    const masked = applyMask({ name: 'Alice' }, ['email']);
    expect(masked).toEqual({ name: 'Alice' });
  });

  it('preserves non-object scalars', () => {
    expect(applyMask('hello', ['email'])).toBe('hello');
    expect(applyMask(42, ['email'])).toBe(42);
    expect(applyMask(null, ['email'])).toBe(null);
  });
});
