/**
 * RED TEAM: Prototype pollution via the JSON-pointer patch system.
 *
 * The patch applier (src/dsl/patches.ts) writes via `parent[key] = value`
 * with NO __proto__/constructor/prototype blocking. We attempt to pollute
 * Object.prototype globally through every patch op that performs a write.
 *
 * Each test pollutes via a patch, then checks whether `({} as any).polluted`
 * (a freshly-created, unrelated object) sees the injected value. If it does,
 * Object.prototype was polluted process-wide => HIGH severity.
 */
import { applyPatches, type Patch } from '../../src/dsl/patches.js';
import { deepMerge, deepClone } from '../../src/stategraph/graph.js';
import type { JsonValue } from '../../src/types.js';

afterEach(() => {
  // Clean up any pollution so one test can't leak into another / the rest of the suite.
  for (const k of ['polluted', 'pollutedA', 'pollutedB', 'pollutedC', 'pollutedD', 'isAdmin', 'x']) {
    // eslint-disable-next-line no-prototype-builtins
    if (Object.prototype.hasOwnProperty.call(Object.prototype, k)) {
      delete (Object.prototype as Record<string, unknown>)[k];
    }
    if (Object.prototype.hasOwnProperty.call(Array.prototype, k)) {
      delete (Array.prototype as unknown as Record<string, unknown>)[k];
    }
  }
});

describe('proto-pollution via patch system', () => {
  test('VECTOR 1: add op with /__proto__/polluted does NOT pollute Object.prototype', () => {
    const patch: Patch = { op: 'add', path: '/__proto__/pollutedA', value: 'pwned' };
    try {
      applyPatches({} as JsonValue, [patch], 'reducer', { autoVivify: true });
    } catch (e) {
      // even if it throws, check nothing leaked
      void e;
    }
    expect(({} as Record<string, unknown>)['pollutedA']).toBeUndefined();
  });

  test('VECTOR 2: replace op with /constructor/prototype/pollutedB pollutes Object.prototype', () => {
    const patch: Patch = { op: 'replace', path: '/constructor/prototype/pollutedB', value: 'pwned' };
    let threw = false;
    try {
      applyPatches({ a: 1 } as JsonValue, [patch], 'reducer', { autoVivify: true });
    } catch {
      threw = true;
    }
    const leaked = ({} as Record<string, unknown>)['pollutedB'];
    // eslint-disable-next-line no-console
    console.log('[VECTOR 2] threw=%s  freshObject.pollutedB=%o', threw, leaked);
    // ASSERTION: must NOT be polluted. If this fails, prototype pollution succeeded.
    expect(leaked).toBeUndefined();
  });

  test('VECTOR 3: merge op value containing __proto__ key pollutes Object.prototype', () => {
    const patch: Patch = {
      op: 'merge',
      path: '/obj',
      value: { ['__proto__']: { pollutedC: 'pwned' } } as Record<string, JsonValue>,
    };
    try {
      applyPatches({ obj: {} } as JsonValue, [patch], 'reducer', { autoVivify: true });
    } catch { /* ignore */ }
    const leaked = ({} as Record<string, unknown>)['pollutedC'];
    // eslint-disable-next-line no-console
    console.log('[VECTOR 3] freshObject.pollutedC=%o', leaked);
    expect(leaked).toBeUndefined();
  });

  test('VECTOR 4: upsert op with key=__proto__ does NOT pollute Object.prototype', () => {
    const patch: Patch = {
      op: 'upsert',
      path: '/items',
      key: '__proto__',
      value: { ['__proto__']: 'pwned', id: 'x' } as unknown as Record<string, JsonValue>,
    };
    try {
      applyPatches({ items: [] } as JsonValue, [patch], 'reducer', { autoVivify: true });
    } catch { /* ignore */ }
    expect(({} as Record<string, unknown>)['pollutedD']).toBeUndefined();
  });

  test('VECTOR 5: deep merge in patches.ts with nested __proto__ pollutes Object.prototype', () => {
    const patch: Patch = {
      op: 'merge',
      deep: true,
      path: '/obj',
      value: { ['__proto__']: { polluted: 'pwned' } } as Record<string, JsonValue>,
    };
    try {
      applyPatches({ obj: { a: 1 } } as JsonValue, [patch], 'reducer', { autoVivify: true });
    } catch { /* ignore */ }
    const leaked = ({} as Record<string, unknown>)['polluted'];
    // eslint-disable-next-line no-console
    console.log('[VECTOR 5] deepMerge freshObject.polluted=%o', leaked);
    expect(leaked).toBeUndefined();
  });

  test('VECTOR 6: stategraph deepMerge with __proto__ key pollutes Object.prototype', () => {
    const source = JSON.parse('{"__proto__": {"polluted": "pwned"}}') as Record<string, JsonValue>;
    try {
      deepMerge({ a: 1 }, source);
    } catch { /* ignore */ }
    const leaked = ({} as Record<string, unknown>)['polluted'];
    // eslint-disable-next-line no-console
    console.log('[VECTOR 6] stategraph deepMerge freshObject.polluted=%o', leaked);
    expect(leaked).toBeUndefined();
  });

  test('VECTOR 7: stategraph deepClone preserves no __proto__ pollution', () => {
    const source = JSON.parse('{"__proto__": {"polluted": "pwned"}}') as JsonValue;
    try {
      deepClone(source);
    } catch { /* ignore */ }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  test('VECTOR 8: navigate auto-vivify through /constructor builds onto a real prototype', () => {
    // add op that walks /constructor (a function) then writes .prototype.x.
    const patch: Patch = { op: 'add', path: '/constructor/prototype/x', value: 'pwned' };
    try {
      applyPatches({ a: 1 } as JsonValue, [patch], 'reducer', { autoVivify: true });
    } catch { /* ignore */ }
    const leaked = ({} as Record<string, unknown>)['x'];
    // eslint-disable-next-line no-console
    console.log('[VECTOR 8] freshObject.x=%o', leaked);
    expect(leaked).toBeUndefined();
  });
});
