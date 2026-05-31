import { callBuiltin, createFakeRng, type FakeRng } from '../../../src/cel/builtins';
import { CelPhase } from '../../../src/cel/phases';
import { createCelEvaluator } from '../../../src/cel/evaluator';

// The $fake* builtins are no longer module-level functions in BUILTINS: their
// seed + RNG state live per-CelEvaluator instance and are threaded in via
// BuiltinContext.fake. These tests exercise that per-instance path through
// callBuiltin (with an explicit FakeRng) and through the CEL evaluator.

function fakeCtx(phase: CelPhase, fake?: FakeRng) {
  return { phase, fake: fake ?? createFakeRng() };
}

describe('cel/builtins — $fake, $fakeSeed, $fakeFromFormat (per-instance RNG)', () => {
  describe('$fake', () => {
    it('generates a first name from person.firstName', () => {
      const result = callBuiltin('$fake', ['person.firstName'], fakeCtx(CelPhase.Behavior));
      expect(typeof result).toBe('string');
      expect((result as string).length).toBeGreaterThan(0);
    });

    it('generates an email from internet.email', () => {
      const result = callBuiltin('$fake', ['internet.email'], fakeCtx(CelPhase.Behavior)) as string;
      expect(result).toContain('@');
    });

    it('generates a phone number from phone.number', () => {
      const result = callBuiltin('$fake', ['phone.number'], fakeCtx(CelPhase.Behavior));
      expect(typeof result).toBe('string');
      expect((result as string).length).toBeGreaterThan(0);
    });

    it('generates a company name from company.name', () => {
      const result = callBuiltin('$fake', ['company.name'], fakeCtx(CelPhase.Behavior));
      expect(typeof result).toBe('string');
      expect((result as string).length).toBeGreaterThan(0);
    });

    it('throws for non-string argument', () => {
      expect(() => callBuiltin('$fake', [42], fakeCtx(CelPhase.Behavior))).toThrow('CEL_TYPE_ERROR');
    });

    it('throws for missing dot separator', () => {
      expect(() => callBuiltin('$fake', ['noDot'], fakeCtx(CelPhase.Behavior))).toThrow('module.method');
    });

    it('throws for unknown faker module', () => {
      expect(() => callBuiltin('$fake', ['nonexistent.method'], fakeCtx(CelPhase.Behavior))).toThrow('unknown faker category');
    });

    it('throws for unknown faker method', () => {
      expect(() => callBuiltin('$fake', ['person.nonexistentMethod'], fakeCtx(CelPhase.Behavior))).toThrow('unknown faker category');
    });
  });

  describe('$fakeSeed', () => {
    it('returns the seed value', () => {
      const result = callBuiltin('$fakeSeed', [42], fakeCtx(CelPhase.Behavior));
      expect(result).toBe(42);
    });

    it('throws for non-number argument', () => {
      expect(() => callBuiltin('$fakeSeed', ['abc'], fakeCtx(CelPhase.Behavior))).toThrow('CEL_TYPE_ERROR');
    });

    it('produces deterministic results when the same rng is reseeded', () => {
      const rng = createFakeRng();
      const ctx = fakeCtx(CelPhase.Behavior, rng);

      callBuiltin('$fakeSeed', [12345], ctx);
      const name1 = callBuiltin('$fake', ['person.firstName'], ctx);
      const name2 = callBuiltin('$fake', ['person.firstName'], ctx);
      const name3 = callBuiltin('$fake', ['person.firstName'], ctx);

      callBuiltin('$fakeSeed', [12345], ctx);
      const name1b = callBuiltin('$fake', ['person.firstName'], ctx);
      const name2b = callBuiltin('$fake', ['person.firstName'], ctx);
      const name3b = callBuiltin('$fake', ['person.firstName'], ctx);

      expect(name1).toBe(name1b);
      expect(name2).toBe(name2b);
      expect(name3).toBe(name3b);
    });
  });

  describe('$fakeFromFormat', () => {
    it('generates email containing @', () => {
      const result = callBuiltin('$fakeFromFormat', ['email'], fakeCtx(CelPhase.Behavior)) as string;
      expect(result).toContain('@');
    });

    it('generates uuid in uuid format', () => {
      const result = callBuiltin('$fakeFromFormat', ['uuid'], fakeCtx(CelPhase.Behavior)) as string;
      expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it('generates date-time as ISO string', () => {
      const result = callBuiltin('$fakeFromFormat', ['date-time'], fakeCtx(CelPhase.Behavior)) as string;
      expect(() => new Date(result)).not.toThrow();
      expect(new Date(result).toISOString()).toBe(result);
    });

    it('generates uri starting with http', () => {
      const result = callBuiltin('$fakeFromFormat', ['uri'], fakeCtx(CelPhase.Behavior)) as string;
      expect(result).toMatch(/^https?:\/\//);
    });

    it('generates hostname as a domain name', () => {
      const result = callBuiltin('$fakeFromFormat', ['hostname'], fakeCtx(CelPhase.Behavior)) as string;
      expect(result).toContain('.');
    });

    it('generates ipv4 address', () => {
      const result = callBuiltin('$fakeFromFormat', ['ipv4'], fakeCtx(CelPhase.Behavior)) as string;
      expect(result).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
    });

    it('generates alphanumeric fallback for unknown format', () => {
      const result = callBuiltin('$fakeFromFormat', ['unknown-format'], fakeCtx(CelPhase.Behavior)) as string;
      expect(typeof result).toBe('string');
      expect(result.length).toBe(10);
    });

    it('throws for non-string argument', () => {
      expect(() => callBuiltin('$fakeFromFormat', [42], fakeCtx(CelPhase.Behavior))).toThrow('CEL_TYPE_ERROR');
    });

    it('generates date as a valid YYYY-MM-DD string', () => {
      const result = callBuiltin('$fakeFromFormat', ['date'], fakeCtx(CelPhase.Behavior)) as string;
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(new Date(result).getTime())).toBe(false);
    });

    it('generates date-time as a valid round-tripping ISO-8601 string', () => {
      const result = callBuiltin('$fakeFromFormat', ['date-time'], fakeCtx(CelPhase.Behavior)) as string;
      expect(Number.isNaN(new Date(result).getTime())).toBe(false);
      expect(new Date(result).toISOString()).toBe(result);
    });

    it('produces identical date output for the same seed across two evaluations', () => {
      const a = createFakeRng();
      a.seedNumber(98765);
      const dateA = callBuiltin('$fakeFromFormat', ['date'], fakeCtx(CelPhase.Behavior, a));

      const b = createFakeRng();
      b.seedNumber(98765);
      const dateB = callBuiltin('$fakeFromFormat', ['date'], fakeCtx(CelPhase.Behavior, b));

      expect(dateA).toBe(dateB);
    });

    it('produces identical date-time output for the same seed across two evaluations', () => {
      const a = createFakeRng();
      a.seedNumber(98765);
      const dtA = callBuiltin('$fakeFromFormat', ['date-time'], fakeCtx(CelPhase.Behavior, a));

      const b = createFakeRng();
      b.seedNumber(98765);
      const dtB = callBuiltin('$fakeFromFormat', ['date-time'], fakeCtx(CelPhase.Behavior, b));

      expect(dtA).toBe(dtB);
    });

    it('produces different date and date-time output for different seeds', () => {
      const a = createFakeRng();
      a.seedNumber(1);
      const dateA = callBuiltin('$fakeFromFormat', ['date'], fakeCtx(CelPhase.Behavior, a));
      const dtA = callBuiltin('$fakeFromFormat', ['date-time'], fakeCtx(CelPhase.Behavior, a));

      const b = createFakeRng();
      b.seedNumber(2);
      const dateB = callBuiltin('$fakeFromFormat', ['date'], fakeCtx(CelPhase.Behavior, b));
      const dtB = callBuiltin('$fakeFromFormat', ['date-time'], fakeCtx(CelPhase.Behavior, b));

      expect(dateA).not.toBe(dateB);
      expect(dtA).not.toBe(dtB);
    });
  });

  describe('phase restrictions', () => {
    it('allows $fake in Behavior phase', () => {
      const result = callBuiltin('$fake', ['person.firstName'], fakeCtx(CelPhase.Behavior));
      expect(typeof result).toBe('string');
    });

    it('allows $fake in EventHydration phase', () => {
      const result = callBuiltin('$fake', ['person.firstName'], fakeCtx(CelPhase.EventHydration));
      expect(typeof result).toBe('string');
    });

    it('bans $fake in Reducer phase', () => {
      expect(() =>
        callBuiltin('$fake', ['person.firstName'], fakeCtx(CelPhase.Reducer)),
      ).toThrow('CEL_PHASE_BANNED');
    });

    it('allows $fakeSeed in Behavior phase', () => {
      const result = callBuiltin('$fakeSeed', [42], fakeCtx(CelPhase.Behavior));
      expect(result).toBe(42);
    });

    it('bans $fakeSeed in Reducer phase', () => {
      expect(() =>
        callBuiltin('$fakeSeed', [42], fakeCtx(CelPhase.Reducer)),
      ).toThrow('CEL_PHASE_BANNED');
    });

    it('allows $fakeFromFormat in EventHydration phase', () => {
      const result = callBuiltin('$fakeFromFormat', ['email'], fakeCtx(CelPhase.EventHydration));
      expect(typeof result).toBe('string');
    });

    it('bans $fakeFromFormat in Reducer phase', () => {
      expect(() =>
        callBuiltin('$fakeFromFormat', ['email'], fakeCtx(CelPhase.Reducer)),
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

    it('seeds via withRequestContext (string) deterministically', () => {
      const a = createCelEvaluator().withRequestContext({ seed: 'tenant-abc' });
      const first = a.evaluate("$fake('person.firstName')", {}, CelPhase.EventHydration);

      const b = createCelEvaluator().withRequestContext({ seed: 'tenant-abc' });
      const firstB = b.evaluate("$fake('person.firstName')", {}, CelPhase.EventHydration);

      // Same string seed on two independent per-request evaluators yields the same stream.
      expect(first).toBe(firstB);
    });

    it('a request without a seed produces unseeded generation', () => {
      // withRequestContext with no seed returns the (unseeded) root: generation
      // still works (now non-deterministic).
      const cel = createCelEvaluator().withRequestContext({});
      const result = cel.evaluate("$fake('person.firstName')", {}, CelPhase.EventHydration);
      expect(typeof result).toBe('string');
      expect((result as string).length).toBeGreaterThan(0);
    });

    it('rejects $fake in Reducer phase via CEL evaluator', () => {
      const cel = createCelEvaluator();
      expect(() =>
        cel.evaluate("$fake('person.firstName')", {}, CelPhase.Reducer),
      ).toThrow('CEL_PHASE_BANNED');
    });
  });

  describe('per-request isolation — concurrent sub-evaluators with different seeds do not interfere', () => {
    it('two per-request evaluators with different seeds produce independent streams', () => {
      // Both sub-evaluators derive from the SAME shared root, proving the seed
      // lives per-request (in the sub-evaluator), not on the shared instance.
      const root = createCelEvaluator();
      const a = root.withRequestContext({ seed: 'seed-A' });
      const b = root.withRequestContext({ seed: 'seed-B' });

      // Interleave draws across the two sub-evaluators. If state leaked between
      // them, interleaving would perturb each sequence.
      const aInterleaved: unknown[] = [];
      const bInterleaved: unknown[] = [];
      for (let i = 0; i < 5; i++) {
        aInterleaved.push(a.evaluate("$fake('person.fullName')", {}, CelPhase.EventHydration));
        bInterleaved.push(b.evaluate("$fake('person.fullName')", {}, CelPhase.EventHydration));
      }

      // Re-run each in isolation (no interleaving) from the same seeds.
      const a2 = createCelEvaluator().withRequestContext({ seed: 'seed-A' });
      const aIsolated = Array.from({ length: 5 }, () =>
        a2.evaluate("$fake('person.fullName')", {}, CelPhase.EventHydration));

      const b2 = createCelEvaluator().withRequestContext({ seed: 'seed-B' });
      const bIsolated = Array.from({ length: 5 }, () =>
        b2.evaluate("$fake('person.fullName')", {}, CelPhase.EventHydration));

      // Interleaved sequences must equal the isolated sequences → no shared state.
      expect(aInterleaved).toEqual(aIsolated);
      expect(bInterleaved).toEqual(bIsolated);
    });

    it('seeding one request does not seed another request on the same root', () => {
      const root = createCelEvaluator();
      root.withRequestContext({ seed: 'only-me' });
      // A second, unseeded request on the same root must not be affected.
      const unseeded = root.withRequestContext({});
      const r = unseeded.evaluate("$fake('person.firstName')", {}, CelPhase.EventHydration);
      expect(typeof r).toBe('string');
    });
  });
});
