/**
 * Tests for src/sdk/index.ts.
 *
 * REQ-TS-001: SDK exports required surface.
 * REQ-TS-002: registry behaves correctly under concurrent reads/writes.
 * REQ-TS-003: decorator + helper styles register identical entries.
 */

import {
  Reducer,
  reducer,
  registry,
  add,
  remove,
  replace,
  move,
  copy,
  append,
  prepend,
  increment,
  merge,
  upsert,
} from '../../../src/sdk/index.js';

beforeEach(async () => {
  await registry.reset();
});

describe('SDK exports surface (REQ-TS-001)', () => {
  it('exposes patch helpers that produce well-formed Patch objects', () => {
    expect(add('/a', 1)).toEqual({ op: 'add', path: '/a', value: 1 });
    expect(remove('/a')).toEqual({ op: 'remove', path: '/a' });
    expect(replace('/a', 'x')).toEqual({ op: 'replace', path: '/a', value: 'x' });
    expect(move('/a', '/b')).toEqual({ op: 'move', from: '/a', path: '/b' });
    expect(copy('/a', '/b')).toEqual({ op: 'copy', from: '/a', path: '/b' });
    expect(append('/xs', 5)).toEqual({ op: 'append', path: '/xs', value: 5 });
    expect(prepend('/xs', 5)).toEqual({ op: 'prepend', path: '/xs', value: 5 });
    expect(increment('/n', 1)).toEqual({ op: 'increment', path: '/n', by: 1 });
    expect(merge('/o', { x: 1 })).toEqual({ op: 'merge', path: '/o', value: { x: 1 } });
    expect(merge('/o', { x: 1 }, true)).toEqual({ op: 'merge', path: '/o', value: { x: 1 }, deep: true });
    expect(upsert('/xs', 'id', { id: 'a' })).toEqual({
      op: 'upsert',
      path: '/xs',
      key: 'id',
      value: { id: 'a' },
    });
  });
});

describe('reducer() helper (REQ-TS-003)', () => {
  it('registers under "boundary:event"', () => {
    reducer({ boundary: 'Lead', event: 'LeadCreated' }, (_s, _e) => []);
    expect(registry.get({ boundary: 'Lead', event: 'LeadCreated' })).toBeDefined();
  });

  it('returns the function unchanged for caller use', () => {
    const fn = (): never[] => [];
    const out = reducer({ boundary: 'Lead', event: 'X' }, fn);
    expect(out).toBe(fn);
  });
});

describe('Reducer() decorator (REQ-TS-003)', () => {
  it('registers via decorator class style', () => {
    @Reducer({ boundary: 'Opportunity', event: 'OpportunityWon' })
    class OnOpportunityWon {
      apply(): never[] {
        return [];
      }
    }
    void OnOpportunityWon;
    expect(
      registry.get({ boundary: 'Opportunity', event: 'OpportunityWon' }),
    ).toBeDefined();
  });

  it('helper + decorator on the same key collide with BOOT_ERR_REDUCER_CONFLICT', () => {
    reducer({ boundary: 'Lead', event: 'X' }, () => []);
    expect(() => {
      @Reducer({ boundary: 'Lead', event: 'X' })
      class _ {
        apply(): never[] {
          return [];
        }
      }
      void _;
    }).toThrow(/BOOT_ERR_REDUCER_CONFLICT/);
  });
});

describe('Registry (REQ-TS-002)', () => {
  it('snapshot() returns the live entries', () => {
    reducer({ boundary: 'A', event: 'E1' }, () => []);
    reducer({ boundary: 'B', event: 'E2' }, () => []);
    expect(registry.snapshot().length).toBe(2);
  });

  it('reset() clears every entry', async () => {
    reducer({ boundary: 'A', event: 'E' }, () => []);
    await registry.reset();
    expect(registry.snapshot().length).toBe(0);
  });

  it('installSwap() replaces every entry atomically', async () => {
    reducer({ boundary: 'A', event: 'E' }, () => []);
    const replacement = new Map();
    replacement.set('X:Y', {
      boundary: 'X',
      event: 'Y',
      fn: () => [],
      source: 'test',
    });
    await registry.installSwap(replacement);
    expect(registry.get({ boundary: 'A', event: 'E' })).toBeUndefined();
    expect(registry.get({ boundary: 'X', event: 'Y' })).toBeDefined();
  });

  it('register() is awaitable', async () => {
    await registry.register({
      boundary: 'A',
      event: 'E',
      fn: () => [],
      source: 'test',
    });
    expect(registry.get({ boundary: 'A', event: 'E' })).toBeDefined();
  });
});
