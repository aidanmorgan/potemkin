import { BUILTINS, callBuiltin } from '../../../src/cel/builtins';
import { CelPhase } from '../../../src/cel/phases';
import { createCelEvaluator } from '../../../src/cel/evaluator';

describe('cel/builtins — $fake, $fakeSeed, $fakeFromFormat', () => {
  describe('BUILTINS registry', () => {
    it('contains $fake', () => {
      expect('$fake' in BUILTINS).toBe(true);
    });

    it('contains $fakeSeed', () => {
      expect('$fakeSeed' in BUILTINS).toBe(true);
    });

    it('contains $fakeFromFormat', () => {
      expect('$fakeFromFormat' in BUILTINS).toBe(true);
    });
  });

  describe('$fake', () => {
    it('generates a first name from person.firstName', () => {
      const result = BUILTINS['$fake']!('person.firstName');
      expect(typeof result).toBe('string');
      expect((result as string).length).toBeGreaterThan(0);
    });

    it('generates an email from internet.email', () => {
      const result = BUILTINS['$fake']!('internet.email') as string;
      expect(result).toContain('@');
    });

    it('generates a phone number from phone.number', () => {
      const result = BUILTINS['$fake']!('phone.number');
      expect(typeof result).toBe('string');
      expect((result as string).length).toBeGreaterThan(0);
    });

    it('generates a company name from company.name', () => {
      const result = BUILTINS['$fake']!('company.name');
      expect(typeof result).toBe('string');
      expect((result as string).length).toBeGreaterThan(0);
    });

    it('throws for non-string argument', () => {
      expect(() => BUILTINS['$fake']!(42)).toThrow('CEL_TYPE_ERROR');
    });

    it('throws for missing dot separator', () => {
      expect(() => BUILTINS['$fake']!('noDot')).toThrow('module.method');
    });

    it('throws for unknown faker module', () => {
      expect(() => BUILTINS['$fake']!('nonexistent.method')).toThrow('unknown faker category');
    });

    it('throws for unknown faker method', () => {
      expect(() => BUILTINS['$fake']!('person.nonexistentMethod')).toThrow('unknown faker category');
    });
  });

  describe('$fakeSeed', () => {
    it('returns the seed value', () => {
      const result = BUILTINS['$fakeSeed']!(42);
      expect(result).toBe(42);
    });

    it('throws for non-number argument', () => {
      expect(() => BUILTINS['$fakeSeed']!('abc')).toThrow('CEL_TYPE_ERROR');
    });

    it('produces deterministic results when seeded', () => {
      BUILTINS['$fakeSeed']!(12345);
      const name1 = BUILTINS['$fake']!('person.firstName');
      const name2 = BUILTINS['$fake']!('person.firstName');
      const name3 = BUILTINS['$fake']!('person.firstName');

      BUILTINS['$fakeSeed']!(12345);
      const name1b = BUILTINS['$fake']!('person.firstName');
      const name2b = BUILTINS['$fake']!('person.firstName');
      const name3b = BUILTINS['$fake']!('person.firstName');

      expect(name1).toBe(name1b);
      expect(name2).toBe(name2b);
      expect(name3).toBe(name3b);
    });
  });

  describe('$fakeFromFormat', () => {
    it('generates email containing @', () => {
      const result = BUILTINS['$fakeFromFormat']!('email') as string;
      expect(result).toContain('@');
    });

    it('generates uuid in uuid format', () => {
      const result = BUILTINS['$fakeFromFormat']!('uuid') as string;
      expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it('generates date-time as ISO string', () => {
      const result = BUILTINS['$fakeFromFormat']!('date-time') as string;
      expect(() => new Date(result)).not.toThrow();
      expect(new Date(result).toISOString()).toBe(result);
    });

    it('generates uri starting with http', () => {
      const result = BUILTINS['$fakeFromFormat']!('uri') as string;
      expect(result).toMatch(/^https?:\/\//);
    });

    it('generates hostname as a domain name', () => {
      const result = BUILTINS['$fakeFromFormat']!('hostname') as string;
      expect(result).toContain('.');
    });

    it('generates ipv4 address', () => {
      const result = BUILTINS['$fakeFromFormat']!('ipv4') as string;
      expect(result).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
    });

    it('generates alphanumeric fallback for unknown format', () => {
      const result = BUILTINS['$fakeFromFormat']!('unknown-format') as string;
      expect(typeof result).toBe('string');
      expect(result.length).toBe(10);
    });

    it('throws for non-string argument', () => {
      expect(() => BUILTINS['$fakeFromFormat']!(42)).toThrow('CEL_TYPE_ERROR');
    });
  });

  describe('phase restrictions', () => {
    it('allows $fake in Behavior phase', () => {
      const result = callBuiltin('$fake', ['person.firstName'], { phase: CelPhase.Behavior });
      expect(typeof result).toBe('string');
    });

    it('allows $fake in EventHydration phase', () => {
      const result = callBuiltin('$fake', ['person.firstName'], { phase: CelPhase.EventHydration });
      expect(typeof result).toBe('string');
    });

    it('bans $fake in Reducer phase', () => {
      expect(() =>
        callBuiltin('$fake', ['person.firstName'], { phase: CelPhase.Reducer }),
      ).toThrow('CEL_PHASE_BANNED');
    });

    it('allows $fakeSeed in Behavior phase', () => {
      const result = callBuiltin('$fakeSeed', [42], { phase: CelPhase.Behavior });
      expect(result).toBe(42);
    });

    it('bans $fakeSeed in Reducer phase', () => {
      expect(() =>
        callBuiltin('$fakeSeed', [42], { phase: CelPhase.Reducer }),
      ).toThrow('CEL_PHASE_BANNED');
    });

    it('allows $fakeFromFormat in EventHydration phase', () => {
      const result = callBuiltin('$fakeFromFormat', ['email'], { phase: CelPhase.EventHydration });
      expect(typeof result).toBe('string');
    });

    it('bans $fakeFromFormat in Reducer phase', () => {
      expect(() =>
        callBuiltin('$fakeFromFormat', ['email'], { phase: CelPhase.Reducer }),
      ).toThrow('CEL_PHASE_BANNED');
    });
  });

  describe('CEL evaluator integration', () => {
    it('evaluates $fake via CEL expression string', () => {
      const cel = createCelEvaluator();
      const result = cel.evaluate("$fake('person.firstName')", {}, CelPhase.EventHydration);
      expect(typeof result).toBe('string');
      expect((result as string).length).toBeGreaterThan(0);
    });

    it('evaluates $fakeSeed via CEL expression string', () => {
      const cel = createCelEvaluator();
      const result = cel.evaluate('$fakeSeed(42)', {}, CelPhase.EventHydration);
      expect(result).toBe(42);
    });

    it('evaluates $fakeFromFormat via CEL expression string', () => {
      const cel = createCelEvaluator();
      const result = cel.evaluate("$fakeFromFormat('email')", {}, CelPhase.EventHydration) as string;
      expect(result).toContain('@');
    });

    it('deterministic generation through CEL evaluator', () => {
      const cel = createCelEvaluator();

      cel.evaluate('$fakeSeed(42)', {}, CelPhase.EventHydration);
      const name1 = cel.evaluate("$fake('person.firstName')", {}, CelPhase.EventHydration);
      const name2 = cel.evaluate("$fake('person.firstName')", {}, CelPhase.EventHydration);
      const name3 = cel.evaluate("$fake('person.firstName')", {}, CelPhase.EventHydration);

      cel.evaluate('$fakeSeed(42)', {}, CelPhase.EventHydration);
      const name1b = cel.evaluate("$fake('person.firstName')", {}, CelPhase.EventHydration);
      const name2b = cel.evaluate("$fake('person.firstName')", {}, CelPhase.EventHydration);
      const name3b = cel.evaluate("$fake('person.firstName')", {}, CelPhase.EventHydration);

      expect(name1).toBe(name1b);
      expect(name2).toBe(name2b);
      expect(name3).toBe(name3b);
    });

    it('rejects $fake in Reducer phase via CEL evaluator', () => {
      const cel = createCelEvaluator();
      expect(() =>
        cel.evaluate("$fake('person.firstName')", {}, CelPhase.Reducer),
      ).toThrow('CEL_PHASE_BANNED');
    });
  });
});
