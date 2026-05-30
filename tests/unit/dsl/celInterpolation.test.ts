import { firstBareCelReference, hasBareCelReference } from '../../../src/dsl/celInterpolation';

describe('celInterpolation — bare CEL reference detection (A4)', () => {
  describe('flags bare context references that need ${...}', () => {
    it.each([
      ['event.payload.id', 'event.'],
      ['state.totalLeads + 1', 'state.'],
      ['command.payload.x', 'command.'],
      ['state.x > 0 ? 1 : 2', 'state.'],
    ])('flags %s', (value, token) => {
      expect(firstBareCelReference(value)).toBe(token);
      expect(hasBareCelReference(value)).toBe(true);
    });

    it('flags a bare $builtin', () => {
      expect(firstBareCelReference('$now')).toBe('$now');
    });

    it('flags a reference outside ${...} even when another is interpolated', () => {
      expect(hasBareCelReference('${state.x} and event.y')).toBe(true);
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
      expect(hasBareCelReference(value)).toBe(false);
    });

    it('does not flag a string literal that merely contains "event."', () => {
      expect(hasBareCelReference("'event.happened was logged'")).toBe(false);
    });

    it('does not flag a quoted literal containing a $ sign', () => {
      expect(hasBareCelReference("'$5.00 fee'")).toBe(false);
    });
  });
});
