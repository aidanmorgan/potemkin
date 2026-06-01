import { matchHeadersAnd } from '../../../src/engine/headerMatch';

describe('engine/headerMatch — matchHeadersAnd', () => {
  describe('case-insensitive name lookup', () => {
    it('matches when declared name is uppercase and actual map uses lowercased keys', () => {
      expect(matchHeadersAnd({ 'X-My-Header': 'yes' }, { 'x-my-header': 'yes' })).toBe(true);
    });

    it('matches when declared name is mixed-case and actual map uses lowercased keys', () => {
      expect(matchHeadersAnd({ 'Content-Type': 'application/json' }, { 'content-type': 'application/json' })).toBe(true);
    });

    it('matches when declared name is already lowercase', () => {
      expect(matchHeadersAnd({ 'x-my-header': 'yes' }, { 'x-my-header': 'yes' })).toBe(true);
    });
  });

  describe('any-value sentinels', () => {
    it('"present" sentinel matches any non-undefined value', () => {
      expect(matchHeadersAnd({ 'x-token': 'present' }, { 'x-token': 'anything' })).toBe(true);
    });

    it('"present" sentinel does not match when header is absent', () => {
      expect(matchHeadersAnd({ 'x-token': 'present' }, {})).toBe(false);
    });

    it('"*" sentinel matches any non-undefined value', () => {
      expect(matchHeadersAnd({ 'x-token': '*' }, { 'x-token': 'anything' })).toBe(true);
    });

    it('"*" sentinel does not match when header is absent', () => {
      expect(matchHeadersAnd({ 'x-token': '*' }, {})).toBe(false);
    });

    it('"present" and "*" sentinels work identically — both match arbitrary values', () => {
      const actual = { 'x-header': 'some-value' };
      expect(matchHeadersAnd({ 'x-header': 'present' }, actual)).toBe(
        matchHeadersAnd({ 'x-header': '*' }, actual),
      );
    });
  });

  describe('AND semantics — all declared headers must match', () => {
    it('returns true when all declared headers match', () => {
      expect(
        matchHeadersAnd(
          { 'x-a': 'alpha', 'x-b': 'beta' },
          { 'x-a': 'alpha', 'x-b': 'beta' },
        ),
      ).toBe(true);
    });

    it('returns false when only the first declared header matches', () => {
      expect(
        matchHeadersAnd(
          { 'x-a': 'alpha', 'x-b': 'beta' },
          { 'x-a': 'alpha' },
        ),
      ).toBe(false);
    });

    it('returns false when only the second declared header matches', () => {
      expect(
        matchHeadersAnd(
          { 'x-a': 'alpha', 'x-b': 'beta' },
          { 'x-b': 'beta' },
        ),
      ).toBe(false);
    });

    it('returns false when none of the declared headers are present', () => {
      expect(
        matchHeadersAnd(
          { 'x-a': 'alpha', 'x-b': 'beta' },
          {},
        ),
      ).toBe(false);
    });
  });

  describe('missing header', () => {
    it('returns false when a declared header is absent from actual', () => {
      expect(matchHeadersAnd({ 'x-required': 'value' }, {})).toBe(false);
    });

    it('returns false when declared header absent and actual has unrelated headers', () => {
      expect(matchHeadersAnd({ 'x-required': 'value' }, { 'x-other': 'something' })).toBe(false);
    });
  });

  describe('value mismatch', () => {
    it('returns false when declared header is present but value differs', () => {
      expect(matchHeadersAnd({ 'x-my-header': 'expected' }, { 'x-my-header': 'actual' })).toBe(false);
    });
  });

  describe('empty declared headers', () => {
    it('returns true when declared map is empty (no constraints)', () => {
      expect(matchHeadersAnd({}, { 'x-something': 'value' })).toBe(true);
    });

    it('returns true when both maps are empty', () => {
      expect(matchHeadersAnd({}, {})).toBe(true);
    });
  });

  describe('bug fix — fault rule with uppercase declared header matches case-insensitively', () => {
    it('uppercase declared header matches lowercased actual key (the original fault-evaluator bug)', () => {
      // Before the fix, fault evaluator used reqHeaders[name] (no toLowerCase on name),
      // so 'X-Custom-Header' would never match actual key 'x-custom-header'.
      expect(matchHeadersAnd({ 'X-Custom-Header': 'present' }, { 'x-custom-header': 'some-value' })).toBe(true);
    });

    it('uppercase declared header with exact value matches lowercased actual key', () => {
      expect(matchHeadersAnd({ 'X-Feature-Flag': 'enabled' }, { 'x-feature-flag': 'enabled' })).toBe(true);
    });

    it('uppercase declared header does not match when header is absent', () => {
      expect(matchHeadersAnd({ 'X-Custom-Header': 'present' }, {})).toBe(false);
    });
  });
});
