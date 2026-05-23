import { BUILTINS, callBuiltin } from '../../../src/cel/builtins';
import { CelPhase } from '../../../src/cel/phases';

describe('cel/builtins', () => {
  describe('BUILTINS registry', () => {
    it('contains $uuidv7', () => {
      expect('$uuidv7' in BUILTINS).toBe(true);
    });

    it('contains $now', () => {
      expect('$now' in BUILTINS).toBe(true);
    });

    it('contains $concat', () => {
      expect('$concat' in BUILTINS).toBe(true);
    });

    it('$uuidv7 returns a string', () => {
      const result = BUILTINS['$uuidv7']!();
      expect(typeof result).toBe('string');
    });

    it('$now returns an ISO-8601 string', () => {
      const result = BUILTINS['$now']!() as string;
      expect(() => new Date(result)).not.toThrow();
      expect(new Date(result).toISOString()).toBe(result);
    });

    it('$concat with zero args returns empty string', () => {
      expect(BUILTINS['$concat']!()).toBe('');
    });

    it('$concat joins args as strings', () => {
      expect(BUILTINS['$concat']!('a', 'b', 'c')).toBe('abc');
    });

    it('$concat coerces numbers to strings', () => {
      expect(BUILTINS['$concat']!(1, 2, 3)).toBe('123');
    });

    it('$concat treats null/undefined as empty strings', () => {
      expect(BUILTINS['$concat']!(null, undefined, 'x')).toBe('x');
    });
  });

  describe('callBuiltin', () => {
    it('throws for unknown function name', () => {
      expect(() =>
        callBuiltin('$unknown', [], { phase: CelPhase.Behavior }),
      ).toThrow('CEL_UNKNOWN_BUILTIN');
    });

    it('calls $uuidv7 in Behavior phase', () => {
      const result = callBuiltin('$uuidv7', [], { phase: CelPhase.Behavior });
      expect(typeof result).toBe('string');
    });

    it('calls $now in Behavior phase', () => {
      const result = callBuiltin('$now', [], { phase: CelPhase.Behavior }) as string;
      expect(new Date(result).toISOString()).toBe(result);
    });

    it('calls $uuidv7 in EventHydration phase', () => {
      const result = callBuiltin('$uuidv7', [], { phase: CelPhase.EventHydration });
      expect(typeof result).toBe('string');
    });

    it('throws for $uuidv7 in Reducer phase', () => {
      expect(() =>
        callBuiltin('$uuidv7', [], { phase: CelPhase.Reducer }),
      ).toThrow('CEL_PHASE_BANNED');
    });

    it('throws for $now in Reducer phase', () => {
      expect(() =>
        callBuiltin('$now', [], { phase: CelPhase.Reducer }),
      ).toThrow('CEL_PHASE_BANNED');
    });

    it('allows $concat in Reducer phase', () => {
      const result = callBuiltin('$concat', ['a', 'b'], { phase: CelPhase.Reducer });
      expect(result).toBe('ab');
    });

    it('uses ctx.uuid override for $uuidv7', () => {
      const fakeUuid = () => 'fixed-uuid';
      const result = callBuiltin('$uuidv7', [], { phase: CelPhase.Behavior, uuid: fakeUuid });
      expect(result).toBe('fixed-uuid');
    });

    it('uses ctx.now override for $now', () => {
      const fakeNow = () => '2024-01-01T00:00:00.000Z';
      const result = callBuiltin('$now', [], { phase: CelPhase.Behavior, now: fakeNow });
      expect(result).toBe('2024-01-01T00:00:00.000Z');
    });

    it('phase error message includes function name and phase', () => {
      expect(() =>
        callBuiltin('$now', [], { phase: CelPhase.Reducer }),
      ).toThrow(CelPhase.Reducer);
    });
  });
});
