/**
 * body-type-patterns.test.ts
 *
 * Unit tests for body-level type-pattern matcher support.
 * Tests matchBody / matchTypePattern / isTypePattern from src/specmatic/matcher.ts.
 */

import { isTypePattern, matchTypePattern, matchBody } from '../../../src/specmatic/matcher.js';

// ---------------------------------------------------------------------------
// isTypePattern
// ---------------------------------------------------------------------------

describe('isTypePattern', () => {
  it('recognises parenthesised patterns', () => {
    expect(isTypePattern('(string)')).toBe(true);
    expect(isTypePattern('(number)')).toBe(true);
    expect(isTypePattern('(integer)')).toBe(true);
    expect(isTypePattern('(boolean)')).toBe(true);
    expect(isTypePattern('(null)')).toBe(true);
    expect(isTypePattern('(any)')).toBe(true);
    expect(isTypePattern('(anyvalue)')).toBe(true);
    expect(isTypePattern('(uuid)')).toBe(true);
    expect(isTypePattern('(datetime)')).toBe(true);
    expect(isTypePattern('(date-time)')).toBe(true);
    expect(isTypePattern('(date)')).toBe(true);
  });

  it('recognises bare * wildcard', () => {
    expect(isTypePattern('*')).toBe(true);
  });

  it('does NOT recognise plain strings', () => {
    expect(isTypePattern('hello')).toBe(false);
    expect(isTypePattern('123')).toBe(false);
    expect(isTypePattern('')).toBe(false);
    expect(isTypePattern('string')).toBe(false);
    expect(isTypePattern('()')).toBe(true); // empty parentheses still match pattern regex
  });
});

// ---------------------------------------------------------------------------
// matchTypePattern — per-type tests
// ---------------------------------------------------------------------------

describe('matchTypePattern — (string)', () => {
  it('matches any string', () => {
    expect(matchTypePattern('(string)', 'hello')).toBe(true);
    expect(matchTypePattern('(string)', '')).toBe(true);
    expect(matchTypePattern('(string)', 'UPPERCASE')).toBe(true);
  });

  it('rejects non-strings', () => {
    expect(matchTypePattern('(string)', 42)).toBe(false);
    expect(matchTypePattern('(string)', true)).toBe(false);
    expect(matchTypePattern('(string)', null)).toBe(false);
    expect(matchTypePattern('(string)', { a: 1 })).toBe(false);
  });
});

describe('matchTypePattern — (number)', () => {
  it('matches integers and floats', () => {
    expect(matchTypePattern('(number)', 42)).toBe(true);
    expect(matchTypePattern('(number)', 3.14)).toBe(true);
    expect(matchTypePattern('(number)', 0)).toBe(true);
    expect(matchTypePattern('(number)', -99)).toBe(true);
  });

  it('rejects non-numbers', () => {
    expect(matchTypePattern('(number)', '42')).toBe(false);
    expect(matchTypePattern('(number)', true)).toBe(false);
    expect(matchTypePattern('(number)', null)).toBe(false);
  });
});

describe('matchTypePattern — (integer)', () => {
  it('matches whole numbers', () => {
    expect(matchTypePattern('(integer)', 0)).toBe(true);
    expect(matchTypePattern('(integer)', 7)).toBe(true);
    expect(matchTypePattern('(integer)', -3)).toBe(true);
  });

  it('rejects floats', () => {
    expect(matchTypePattern('(integer)', 3.14)).toBe(false);
    expect(matchTypePattern('(integer)', 1.0000001)).toBe(false);
  });

  it('rejects non-numbers', () => {
    expect(matchTypePattern('(integer)', '5')).toBe(false);
    expect(matchTypePattern('(integer)', null)).toBe(false);
  });
});

describe('matchTypePattern — (boolean)', () => {
  it('matches true and false', () => {
    expect(matchTypePattern('(boolean)', true)).toBe(true);
    expect(matchTypePattern('(boolean)', false)).toBe(true);
  });

  it('rejects truthy non-booleans', () => {
    expect(matchTypePattern('(boolean)', 1)).toBe(false);
    expect(matchTypePattern('(boolean)', 'true')).toBe(false);
    expect(matchTypePattern('(boolean)', null)).toBe(false);
  });
});

describe('matchTypePattern — (null)', () => {
  it('matches null', () => {
    expect(matchTypePattern('(null)', null)).toBe(true);
  });

  it('rejects non-null', () => {
    expect(matchTypePattern('(null)', undefined)).toBe(false);
    expect(matchTypePattern('(null)', 0)).toBe(false);
    expect(matchTypePattern('(null)', '')).toBe(false);
    expect(matchTypePattern('(null)', false)).toBe(false);
  });
});

describe('matchTypePattern — (any) / (anyvalue) / *', () => {
  const patterns = ['(any)', '(anyvalue)', '*'];

  for (const p of patterns) {
    it(`${p} matches any value`, () => {
      expect(matchTypePattern(p, 'text')).toBe(true);
      expect(matchTypePattern(p, 0)).toBe(true);
      expect(matchTypePattern(p, null)).toBe(true);
      expect(matchTypePattern(p, true)).toBe(true);
      expect(matchTypePattern(p, { x: 1 })).toBe(true);
      expect(matchTypePattern(p, [1, 2])).toBe(true);
    });
  }
});

describe('matchTypePattern — (uuid)', () => {
  it('matches valid UUID v4', () => {
    expect(matchTypePattern('(uuid)', '550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(matchTypePattern('(uuid)', 'A987FBC9-4BED-3078-CF07-9141BA07C9F3')).toBe(true);
  });

  it('rejects malformed UUIDs', () => {
    expect(matchTypePattern('(uuid)', 'not-a-uuid')).toBe(false);
    expect(matchTypePattern('(uuid)', '550e8400e29b41d4a716446655440000')).toBe(false);
    expect(matchTypePattern('(uuid)', '')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(matchTypePattern('(uuid)', 12345)).toBe(false);
    expect(matchTypePattern('(uuid)', null)).toBe(false);
  });
});

describe('matchTypePattern — (datetime) / (date-time)', () => {
  const patterns = ['(datetime)', '(date-time)'];

  for (const p of patterns) {
    it(`${p} matches ISO-8601 datetimes`, () => {
      expect(matchTypePattern(p, '2026-05-24T10:00:00Z')).toBe(true);
      expect(matchTypePattern(p, '2026-05-24T10:00:00.000Z')).toBe(true);
      expect(matchTypePattern(p, '2026-05-24T10:00:00+10:00')).toBe(true);
      expect(matchTypePattern(p, '2026-05-24T10:00:00-05:00')).toBe(true);
    });

    it(`${p} rejects date-only strings`, () => {
      expect(matchTypePattern(p, '2026-05-24')).toBe(false);
    });

    it(`${p} rejects non-strings`, () => {
      expect(matchTypePattern(p, 1716528000000)).toBe(false);
      expect(matchTypePattern(p, null)).toBe(false);
    });
  }
});

describe('matchTypePattern — (date)', () => {
  it('matches ISO date strings', () => {
    expect(matchTypePattern('(date)', '2026-05-24')).toBe(true);
    expect(matchTypePattern('(date)', '2000-01-01')).toBe(true);
  });

  it('rejects datetime strings', () => {
    expect(matchTypePattern('(date)', '2026-05-24T10:00:00Z')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(matchTypePattern('(date)', null)).toBe(false);
    expect(matchTypePattern('(date)', 20260524)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// matchBody — top-level integration
// ---------------------------------------------------------------------------

describe('matchBody — type patterns at leaves', () => {
  it('flat object with type patterns matches valid request body', () => {
    expect(
      matchBody(
        { amount: '(number)', name: '(string)' },
        { amount: 99.5, name: 'Alice' },
      ),
    ).toBe(true);
  });

  it('flat object with type patterns rejects wrong types', () => {
    expect(
      matchBody(
        { amount: '(number)', name: '(string)' },
        { amount: 'not-a-number', name: 'Alice' },
      ),
    ).toBe(false);
  });

  it('mixed: literal + type pattern', () => {
    expect(
      matchBody(
        { riskBand: 'LOW', amount: '(integer)' },
        { riskBand: 'LOW', amount: 500 },
      ),
    ).toBe(true);

    expect(
      matchBody(
        { riskBand: 'LOW', amount: '(integer)' },
        { riskBand: 'LOW', amount: 500.5 },
      ),
    ).toBe(false);
  });

  it('plain string leaf still requires exact match', () => {
    expect(matchBody({ name: 'Alice' }, { name: 'Alice' })).toBe(true);
    expect(matchBody({ name: 'Alice' }, { name: 'Bob' })).toBe(false);
  });

  it('nested object with type pattern at leaf', () => {
    expect(
      matchBody(
        { customer: { id: '(uuid)', active: '(boolean)' } },
        { customer: { id: '550e8400-e29b-41d4-a716-446655440000', active: true } },
      ),
    ).toBe(true);
  });

  it('array element with type pattern', () => {
    expect(
      matchBody(
        [{ id: '(string)', amount: '(number)' }],
        [{ id: 'tx-001', amount: 1200 }],
      ),
    ).toBe(true);
  });

  it('(any) / * at leaf accepts any value', () => {
    expect(matchBody({ meta: '(any)' }, { meta: { nested: true } })).toBe(true);
    expect(matchBody({ meta: '*' }, { meta: null })).toBe(true);
  });

  it('absent matcher body skips check (any body matches)', () => {
    expect(matchBody(undefined, { anything: true })).toBe(true);
    expect(matchBody(null, { anything: true })).toBe(true);
  });

  it('key count mismatch still fails', () => {
    expect(
      matchBody(
        { a: '(string)', b: '(number)' },
        { a: 'x' },
      ),
    ).toBe(false);
  });
});
