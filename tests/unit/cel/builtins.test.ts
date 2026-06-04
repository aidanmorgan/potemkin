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

  // ── string() / $concat coerce objects/arrays to JSON ─────────────────────
  describe('string() coerces objects and arrays to JSON', () => {
    it('string() of a map produces valid JSON', () => {
      expect(BUILTINS['string']!({ a: 1 })).toBe('{"a":1}');
    });

    it('string() of a list produces valid JSON', () => {
      expect(BUILTINS['string']!([1, 2, 3])).toBe('[1,2,3]');
    });

    it('string() of an empty map produces {}', () => {
      expect(BUILTINS['string']!({})).toBe('{}');
    });

    it('string() of an empty list produces []', () => {
      expect(BUILTINS['string']!([])).toBe('[]');
    });
  });

  describe('$concat coerces objects and arrays to JSON', () => {
    it('$concat with a list arg produces JSON, not comma-joined', () => {
      expect(BUILTINS['$concat']!('prefix-', [1, 2])).toBe('prefix-[1,2]');
    });

    it('$concat with a map arg produces JSON, not [object Object]', () => {
      expect(BUILTINS['$concat']!('data:', { x: 1 })).toBe('data:{"x":1}');
    });
  });

  // ── min([]) and max([]) throw a runtime error ───────────────────────────────
  describe('min/max on an empty list throw CEL_RUNTIME_ERROR', () => {
    it('min([]) throws CEL_RUNTIME_ERROR', () => {
      expect(() => BUILTINS['min']!([])).toThrow('CEL_RUNTIME_ERROR: min() of empty list');
    });

    it('max([]) throws CEL_RUNTIME_ERROR', () => {
      expect(() => BUILTINS['max']!([])).toThrow('CEL_RUNTIME_ERROR: max() of empty list');
    });

    it('min on non-empty list still works', () => {
      expect(BUILTINS['min']!([3, 1, 2])).toBe(1);
    });

    it('max on non-empty list still works', () => {
      expect(BUILTINS['max']!([3, 1, 2])).toBe(3);
    });
  });

  // ── duration("P") and duration("PT") throw ─────────────────────────────────
  describe('duration() rejects degenerate ISO strings', () => {
    it('duration("P") throws the unparseable-duration error', () => {
      expect(() => BUILTINS['duration']!('P')).toThrow('CEL_RUNTIME_ERROR: invalid duration string');
    });

    it('duration("PT") throws the unparseable-duration error', () => {
      expect(() => BUILTINS['duration']!('PT')).toThrow('CEL_RUNTIME_ERROR: invalid duration string');
    });

    it('duration("P1D") still parses correctly', () => {
      expect(BUILTINS['duration']!('P1D')).toBe(86400000);
    });

    it('duration("PT2H") still parses correctly', () => {
      expect(BUILTINS['duration']!('PT2H')).toBe(7200000);
    });

    it('duration("P1DT2H3M4S") still parses correctly', () => {
      expect(BUILTINS['duration']!('P1DT2H3M4S')).toBe(93784000);
    });

    it('duration shorthand "30s" still parses correctly', () => {
      expect(BUILTINS['duration']!('30s')).toBe(30000);
    });
  });
});
