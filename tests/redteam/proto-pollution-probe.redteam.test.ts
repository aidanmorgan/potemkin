/**
 * RED TEAM probe: understand precisely WHY the patch system resists proto
 * pollution, and try to defeat the defenses. We probe the exact mechanics so
 * the "safe" verdict is grounded, not accidental.
 */
import { applyPatches, type Patch } from '../../src/dsl/patches.js';
import type { JsonValue } from '../../src/types.js';

afterEach(() => {
  for (const k of ['polluted', 'x', 'isAdmin']) {
    if (Object.prototype.hasOwnProperty.call(Object.prototype, k)) {
      delete (Object.prototype as Record<string, unknown>)[k];
    }
  }
});

describe('proto-pollution mechanics probe', () => {
  test('PROBE A: structuredClone of {__proto__ own prop} — does the own prop survive?', () => {
    const evil = { ['__proto__']: { polluted: 'pwned' } } as Record<string, unknown>;
    const ownBefore = Object.prototype.hasOwnProperty.call(evil, '__proto__');
    const cloned = structuredClone(evil);
    const ownAfter = Object.prototype.hasOwnProperty.call(cloned, '__proto__');
    // eslint-disable-next-line no-console
    console.log('[PROBE A] __proto__ own before clone=%s after clone=%s', ownBefore, ownAfter);
    expect(typeof ownAfter).toBe('boolean');
  });

  test('PROBE B: navigate /constructor shadows constructor instead of reaching Function.prototype', () => {
    const state = { a: 1 } as Record<string, JsonValue>;
    const patch: Patch = { op: 'add', path: '/constructor/prototype/x', value: 'pwned' };
    const result = applyPatches(state as JsonValue, [patch], 'reducer', { autoVivify: true });
    const newState = result.newState as Record<string, unknown>;
    const ctor = newState['constructor'];
    // If 'constructor' is now a PLAIN object (shadowed), the real Function.prototype was never touched.
    // eslint-disable-next-line no-console
    console.log('[PROBE B] newState.constructor is plain-object=%s value=%o',
      ctor !== null && typeof ctor === 'object', ctor);
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
    // The shadow lives only on the cloned state — does it now expose `.prototype.x` on that state object only?
    const ctorObj = ctor as Record<string, unknown> | undefined;
    const proto = ctorObj?.['prototype'] as Record<string, unknown> | undefined;
    // eslint-disable-next-line no-console
    console.log('[PROBE B] shadowed-state constructor.prototype.x=%o', proto?.['x']);
  });

  test('PROBE C: __proto__ via single-segment path /__proto__ sets the value object prototype only', () => {
    const state = {} as Record<string, JsonValue>;
    const patch: Patch = { op: 'add', path: '/__proto__', value: { polluted: 'pwned' } as JsonValue };
    const result = applyPatches(state as JsonValue, [patch], 'reducer', { autoVivify: true });
    const ns = result.newState as Record<string, unknown>;
    // eslint-disable-next-line no-console
    console.log('[PROBE C] newState.__proto__ own=%s, freshObj.polluted=%o',
      Object.prototype.hasOwnProperty.call(ns, '__proto__'),
      ({} as Record<string, unknown>)['polluted']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  test('PROBE D: does the polluted state object ITSELF carry an attacker-controlled __proto__? (local contamination)', () => {
    // Even if global Object.prototype is safe, can an attacker make the RETURNED
    // state object inherit attacker props, so a later `state.isAdmin` read returns true?
    const state = {} as Record<string, JsonValue>;
    const patch: Patch = {
      op: 'merge',
      path: '',
      value: { ['__proto__']: { isAdmin: true } } as Record<string, JsonValue>,
    };
    let threw = false;
    try {
      const result = applyPatches(state as JsonValue, [patch], 'reducer', { autoVivify: true });
      const ns = result.newState as Record<string, unknown>;
      // eslint-disable-next-line no-console
      console.log('[PROBE D] state.isAdmin (inherited?)=%o', ns['isAdmin']);
    } catch (e) {
      threw = true;
      // eslint-disable-next-line no-console
      console.log('[PROBE D] threw=%s msg=%s', threw, (e as Error).message);
    }
    expect(({} as Record<string, unknown>)['isAdmin']).toBeUndefined();
  });
});
