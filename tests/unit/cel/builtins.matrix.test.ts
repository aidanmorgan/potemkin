import { BUILTINS, callBuiltin, createFakeRng } from '../../../src/cel/builtins.js';
import { CelPhase } from '../../../src/cel/phases.js';

const call = (name: string, ...args: unknown[]): unknown => BUILTINS[name]!(...args);

describe('CEL builtin value and error matrix', () => {
  it.each([
    ['int', [3.9], 3],
    ['int', ['4.8'], 4],
    ['int', [true], 1],
    ['double', [3], 3],
    ['double', ['4.5'], 4.5],
    ['double', [false], 0],
    ['string', [null], 'null'],
    ['string', [{ nested: true }], '{"nested":true}'],
    ['bool', [true], true],
    ['bool', ['true'], true],
    ['bool', ['false'], false],
    ['bool', [0], false],
    ['bool', [2], true],
    ['bytes', ['Aÿ'], [65, 255]],
  ])('converts %s values', (name, args, expected) => {
    expect(call(name, ...(args as unknown[]))).toEqual(expected);
  });

  it('rejects invalid conversions and computes scalar math', () => {
    expect(() => call('int', 'nope')).toThrow('int()');
    expect(() => call('int', null)).toThrow('int()');
    expect(() => call('double', 'nope')).toThrow('double()');
    expect(() => call('double', null)).toThrow('double()');
    expect(() => call('bool', 'maybe')).toThrow('bool()');
    expect(() => call('bool', null)).toThrow('bool()');
    expect(() => call('bytes', 1)).toThrow('bytes()');
    expect(call('abs', -3)).toBe(3);
    expect(call('min', 4, 2, 3)).toBe(2);
    expect(call('min', [4, 2, 3])).toBe(2);
    expect(call('max', 4, 2, 3)).toBe(4);
    expect(call('max', [4, 2, 3])).toBe(4);
    expect(call('floor', 3.9)).toBe(3);
    expect(call('ceil', 3.1)).toBe(4);
    expect(call('round', 3.5)).toBe(4);
    expect(call('pow', 2, 3)).toBe(8);
    expect(call('sqrt', 9)).toBe(3);
    expect(() => call('sqrt', -1)).toThrow('negative');
    for (const [name, args] of [
      ['abs', ['1']],
      ['floor', ['1']],
      ['ceil', ['1']],
      ['round', ['1']],
      ['pow', [1, '2']],
    ] as const) {
      expect(() => call(name, ...args)).toThrow('requires');
    }
  });

  it('handles collection, map, type, and null helper variants', () => {
    expect(call('size', 'abc')).toBe(3);
    expect(call('size', [1, 2])).toBe(2);
    expect(call('size', { a: 1, b: 2 })).toBe(2);
    expect(call('length', 'abc')).toBe(3);
    expect(call('length', [1, 2])).toBe(2);
    expect(call('length', { a: 1 })).toBe(1);
    expect(() => call('size', 1)).toThrow('size()');
    expect(() => call('length', 1)).toThrow('length()');
    expect(call('sum', [1, null, 2, undefined])).toBe(3);
    expect(call('sum', 1, 2, 3)).toBe(6);
    expect(() => call('sum', [1, '2'])).toThrow('sum()');
    expect(call('keys', { a: 1 })).toEqual(['a']);
    expect(call('values', { a: 1 })).toEqual([1]);
    expect(() => call('keys', [])).toThrow('keys()');
    expect(() => call('values', null)).toThrow('values()');
    expect(call('range', 3.9)).toEqual([0, 1, 2]);
    expect(call('range', 2, 5)).toEqual([2, 3, 4]);
    expect(call('range', 5, 2)).toEqual([]);
    expect(() => call('range')).toThrow('1 or 2');
    expect(() => call('range', '3')).toThrow('number');
    expect(call('type', null)).toBe('null');
    expect(call('type', true)).toBe('bool');
    expect(call('type', 'x')).toBe('string');
    expect(call('type', 1)).toBe('int');
    expect(call('type', 1.5)).toBe('double');
    expect(call('type', [1, 2])).toBe('bytes');
    expect(call('type', [256])).toBe('list');
    expect(call('type', { a: 1 })).toBe('map');
    expect(call('coalesce', null, undefined, 'value')).toBe('value');
    expect(call('coalesce', null, undefined)).toBeNull();
    expect(call('default', 'value', 'fallback')).toBe('value');
    expect(call('default', null, undefined)).toBeNull();
  });

  it('parses timestamp and every supported duration form', () => {
    expect(call('timestamp', '2026-01-01T00:00:00Z')).toBe('2026-01-01T00:00:00.000Z');
    expect(call('duration', 'P1DT2H3M4.5S')).toBe(93_784_500);
    expect(call('duration', 'PT1H')).toBe(3_600_000);
    expect(call('duration', '30s')).toBe(30_000);
    expect(call('duration', '1.5m')).toBe(90_000);
    expect(call('duration', '2h')).toBe(7_200_000);
    expect(call('duration', '3d')).toBe(259_200_000);
    expect(() => call('timestamp', 1)).toThrow('timestamp()');
    expect(() => call('timestamp', 'not-a-date')).toThrow('invalid date');
    expect(() => call('duration', 1)).toThrow('duration()');
    expect(() => call('duration', 'P')).toThrow('invalid duration');
    expect(() => call('duration', 'PT')).toThrow('invalid duration');
    expect(() => call('duration', '1w')).toThrow('invalid duration');
  });

  it('covers faker categories, seeded reset, clock context, and custom dispatch', () => {
    const rng = createFakeRng(() => 0.5);
    for (const spec of [
      'person.lastName',
      'person.fullName',
      'internet.url',
      'internet.domainName',
      'address.city',
      'address.streetAddress',
    ]) {
      expect(typeof callBuiltin('$fake', [spec], { phase: CelPhase.Behavior, fake: rng })).toBe(
        'string',
      );
    }
    const seeded = createFakeRng(() => 0);
    seeded.seedString('tenant');
    const first = seeded.next();
    seeded.seedString('tenant');
    expect(seeded.next()).toBe(first);
    seeded.seedString(undefined);
    expect(seeded.next()).toBe(0);
    expect(
      callBuiltin('$fakeFromFormat', ['url'], { phase: CelPhase.Behavior, fake: rng }),
    ).toEqual(expect.stringContaining('https://'));

    const now = '2026-01-01T00:00:00.000Z';
    expect(callBuiltin('$now', [], { phase: CelPhase.Behavior, now: () => now })).toBe(now);
    expect(callBuiltin('now', [], { phase: CelPhase.Behavior, now: () => now })).toBe(now);
    expect(callBuiltin('$unix', [], { phase: CelPhase.Behavior, now: () => now })).toBe(
      1_767_225_600,
    );
    expect(callBuiltin('$unix', [], { phase: CelPhase.Behavior, now: () => 'invalid' })).toEqual(
      expect.any(Number),
    );
    const custom = new Map([
      [
        'custom',
        (args: readonly unknown[], context: Readonly<Record<string, unknown>>) => ({
          args,
          context,
        }),
      ],
    ]);
    expect(
      callBuiltin('custom', [1], { phase: CelPhase.Behavior, custom, context: { source: 'test' } }),
    ).toEqual({ args: [1], context: { source: 'test' } });
    expect(() => callBuiltin('missing', [], { phase: CelPhase.Behavior })).toThrow(
      'UNKNOWN_BUILTIN',
    );
    expect(() => callBuiltin('$uuidv7', [], { phase: CelPhase.Reducer })).toThrow('PHASE_BANNED');
  });
});
