import { nextUuidv7, epochAnchoredUuidv7, isUuidv7 } from '../../../src/ids/uuidv7';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('ids/uuidv7', () => {
  describe('nextUuidv7', () => {
    it('returns a string', () => {
      expect(typeof nextUuidv7()).toBe('string');
    });

    it('matches UUID format 8-4-4-4-12', () => {
      const id = nextUuidv7();
      expect(id).toMatch(UUID_RE);
    });

    it('version nibble is 7', () => {
      const id = nextUuidv7();
      expect(id.charAt(14)).toBe('7');
    });

    it('variant nibble is in [89ab]', () => {
      const id = nextUuidv7();
      expect(['8', '9', 'a', 'b']).toContain(id.charAt(19));
    });

    it('produces distinct values on successive calls', () => {
      const ids = new Set(Array.from({ length: 20 }, () => nextUuidv7()));
      expect(ids.size).toBe(20);
    });

    it('is monotonically ordered when called in sequence', () => {
      const ids = Array.from({ length: 10 }, () => nextUuidv7());
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i]! >= ids[i - 1]!).toBe(true);
      }
    });
  });

  describe('epochAnchoredUuidv7', () => {
    it('returns a string', () => {
      expect(typeof epochAnchoredUuidv7(0)).toBe('string');
    });

    it('matches UUID format', () => {
      expect(epochAnchoredUuidv7(0)).toMatch(UUID_RE);
    });

    it('version nibble is 7', () => {
      expect(epochAnchoredUuidv7(0).charAt(14)).toBe('7');
    });

    it('variant nibble is in [89ab]', () => {
      const id = epochAnchoredUuidv7(0);
      expect(['8', '9', 'a', 'b']).toContain(id.charAt(19));
    });

    it('first 12 hex chars are 000000000000 (epoch 0 timestamp)', () => {
      const id = epochAnchoredUuidv7(0).replace(/-/g, '');
      expect(id.slice(0, 12)).toBe('000000000000');
    });

    it('is deterministic: same seedIndex produces same ID', () => {
      expect(epochAnchoredUuidv7(42)).toBe(epochAnchoredUuidv7(42));
    });

    it('different seedIndexes produce different IDs', () => {
      expect(epochAnchoredUuidv7(0)).not.toBe(epochAnchoredUuidv7(1));
    });

    it('produces a valid isUuidv7 result', () => {
      expect(isUuidv7(epochAnchoredUuidv7(0))).toBe(true);
    });

    it('handles large seed index', () => {
      const id = epochAnchoredUuidv7(9999999);
      expect(isUuidv7(id)).toBe(true);
    });

    it('seedIndex 0 and seedIndex 100 are different', () => {
      expect(epochAnchoredUuidv7(0)).not.toBe(epochAnchoredUuidv7(100));
    });
  });

  describe('isUuidv7', () => {
    it('returns true for a valid v7 UUID', () => {
      expect(isUuidv7(nextUuidv7())).toBe(true);
    });

    it('returns true for a valid epoch-anchored v7 UUID', () => {
      expect(isUuidv7(epochAnchoredUuidv7(0))).toBe(true);
    });

    it('returns false for empty string', () => {
      expect(isUuidv7('')).toBe(false);
    });

    it('returns false for a v4 UUID (version nibble 4)', () => {
      expect(isUuidv7('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    });

    it('returns false for malformed UUID (wrong length)', () => {
      expect(isUuidv7('not-a-uuid')).toBe(false);
    });

    it('returns false when version nibble is not 7', () => {
      expect(isUuidv7('00000000-0000-4000-8000-000000000000')).toBe(false);
    });

    it('returns false when variant bits are wrong', () => {
      // variant nibble at position 19 is 0, not [89ab]
      expect(isUuidv7('00000000-0000-7000-0000-000000000000')).toBe(false);
    });

    it('is case-insensitive', () => {
      const upper = nextUuidv7().toUpperCase();
      expect(isUuidv7(upper)).toBe(true);
    });
  });
});
