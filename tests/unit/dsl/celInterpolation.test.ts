import { firstBareCelReference } from '../../../src/dsl/celInterpolation';

describe('celInterpolation — bare CEL reference detection (A4)', () => {
  describe('flags bare context references that need ${...}', () => {
    it.each([
      ['event.payload.id', 'event.'],
      ['state.totalLeads + 1', 'state.'],
      ['command.payload.x', 'command.'],
      ['state.x > 0 ? 1 : 2', 'state.'],
    ])('flags %s', (value, token) => {
      expect(firstBareCelReference(value)).toBe(token);
    });

    it('flags a bare $builtin', () => {
      expect(firstBareCelReference('$now')).toBe('$now');
    });

    it('flags a reference outside ${...} even when another is interpolated', () => {
      expect(firstBareCelReference('${state.x} and event.y')).toBe('event.');
    });
  });

  describe('accepts clean values', () => {
    it.each([
      "'NEW'",
      "'PAUSED'",
      '0',
      '${event.payload.id}',
      '${state.totalLeads != null ? state.totalLeads + 1 : 1}',
      '${state.x}-suffix',
      'plainLiteral',
    ])('accepts %s', (value) => {
      expect(firstBareCelReference(value)).toBeNull();
    });

    it('does not flag a string literal that merely contains "event."', () => {
      expect(firstBareCelReference("'event.happened was logged'")).toBeNull();
    });

    it('does not flag a quoted literal containing a $ sign', () => {
      expect(firstBareCelReference("'$5.00 fee'")).toBeNull();
    });

    it('does not flag a bare $ followed by a digit (not a builtin token)', () => {
      expect(firstBareCelReference('$5 discount')).toBeNull();
    });
  });

  describe('text containing characters CEL cannot lex', () => {
    it('still finds a real reference before an unlexable stray character', () => {
      // The trailing '@' is not lexable as CEL; the scan must still surface the
      // state.x reference that precedes it.
      expect(firstBareCelReference('state.x @')).toBe('state.');
    });

    it('returns null when only unlexable text is present', () => {
      expect(firstBareCelReference('@@@')).toBeNull();
    });
  });
});
