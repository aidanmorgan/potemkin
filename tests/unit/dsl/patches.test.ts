/**
 * Unit tests for the patches module.
 *
 * REQ-PATCH-001: single patch vocabulary covers RFC 6902 + Potemkin extensions
 * REQ-PATCH-002: build-new-state-then-swap atomicity (input untouched on
 *                success; candidate discarded on failure)
 * REQ-PATCH-004: per-source journal tags
 */

import {
  applyPatches,
  PatchApplyError,
  parsePointer,
  joinPointer,
  type Patch,
} from '../../../src/dsl/patches.js';

describe('patches.applyPatches — RFC 6902 ops', () => {
  it('add inserts a new object property', () => {
    const state = { a: 1 };
    const { newState, journal, touchedPaths } = applyPatches(state, [
      { op: 'add', path: '/b', value: 2 },
    ]);
    expect(newState).toEqual({ a: 1, b: 2 });
    expect(state).toEqual({ a: 1 }); // input never mutated (REQ-PATCH-002 AC-002.4)
    expect(journal[0]).toMatchObject({ source: 'reducer', op: 'add', path: '/b', value: 2 });
    expect(touchedPaths.has('/b')).toBe(true);
  });

  it('replace overwrites an existing property', () => {
    const state = { a: 1, b: 2 };
    const { newState } = applyPatches(state, [
      { op: 'replace', path: '/a', value: 99 },
    ]);
    expect(newState).toEqual({ a: 99, b: 2 });
  });

  it('replace fails when target is missing', () => {
    expect(() =>
      applyPatches({ a: 1 }, [{ op: 'replace', path: '/missing', value: 0 }]),
    ).toThrow(PatchApplyError);
  });

  it('remove deletes an existing key', () => {
    const state = { a: 1, b: 2 };
    const { newState } = applyPatches(state, [{ op: 'remove', path: '/a' }]);
    expect(newState).toEqual({ b: 2 });
  });

  it('remove fails when target is missing', () => {
    expect(() =>
      applyPatches({}, [{ op: 'remove', path: '/x' }]),
    ).toThrow(PatchApplyError);
  });

  it('move relocates a value', () => {
    const state = { a: { x: 1 }, b: {} };
    const { newState } = applyPatches(state, [
      { op: 'move', from: '/a/x', path: '/b/x' },
    ]);
    expect(newState).toEqual({ a: {}, b: { x: 1 } });
  });

  it('copy duplicates a value', () => {
    const state = { a: 1 };
    const { newState } = applyPatches(state, [
      { op: 'copy', from: '/a', path: '/b' },
    ]);
    expect(newState).toEqual({ a: 1, b: 1 });
  });

  it('add into an array at index inserts (does not replace)', () => {
    const state = { items: [10, 20] };
    const { newState } = applyPatches(state, [
      { op: 'add', path: '/items/1', value: 15 },
    ]);
    expect(newState).toEqual({ items: [10, 15, 20] });
  });

  it("add at '/items/-' appends to end", () => {
    const state = { items: [1, 2] };
    const { newState } = applyPatches(state, [
      { op: 'add', path: '/items/-', value: 3 },
    ]);
    expect(newState).toEqual({ items: [1, 2, 3] });
  });
});

describe('patches.applyPatches — Potemkin extensions', () => {
  it('append pushes to an array', () => {
    const state = { items: [1, 2] };
    const { newState } = applyPatches(state, [
      { op: 'append', path: '/items', value: 3 },
    ]);
    expect(newState).toEqual({ items: [1, 2, 3] });
  });

  it('prepend inserts at front', () => {
    const state = { items: [2, 3] };
    const { newState } = applyPatches(state, [
      { op: 'prepend', path: '/items', value: 1 },
    ]);
    expect(newState).toEqual({ items: [1, 2, 3] });
  });

  it('append fails when target is not an array', () => {
    expect(() =>
      applyPatches({ x: 1 }, [{ op: 'append', path: '/x', value: 1 }]),
    ).toThrow(PatchApplyError);
  });

  it('increment adds to a numeric field', () => {
    const state = { count: 5 };
    const { newState } = applyPatches(state, [
      { op: 'increment', path: '/count', by: 3 },
    ]);
    expect(newState).toEqual({ count: 8 });
  });

  it('increment fails on non-numeric target', () => {
    expect(() =>
      applyPatches({ x: 'str' }, [{ op: 'increment', path: '/x', by: 1 }]),
    ).toThrow(PatchApplyError);
  });

  it('merge (shallow) overrides per-key', () => {
    const state = { meta: { a: 1, b: { x: 0 } } };
    const { newState } = applyPatches(state, [
      { op: 'merge', path: '/meta', value: { b: { y: 9 }, c: 3 } },
    ]);
    expect(newState).toEqual({ meta: { a: 1, b: { y: 9 }, c: 3 } });
  });

  it('merge (deep) recurses into nested objects', () => {
    const state = { meta: { a: 1, b: { x: 0 } } };
    const { newState } = applyPatches(state, [
      { op: 'merge', path: '/meta', value: { b: { y: 9 }, c: 3 }, deep: true },
    ]);
    expect(newState).toEqual({ meta: { a: 1, b: { x: 0, y: 9 }, c: 3 } });
  });

  it('upsert by key updates an existing entry', () => {
    const state = { lineItems: [{ id: 'a', qty: 1 }, { id: 'b', qty: 2 }] };
    const { newState } = applyPatches(state, [
      { op: 'upsert', path: '/lineItems', key: 'id', value: { id: 'a', qty: 9 } },
    ]);
    expect(newState).toEqual({ lineItems: [{ id: 'a', qty: 9 }, { id: 'b', qty: 2 }] });
  });

  it('upsert by key appends when no match', () => {
    const state = { lineItems: [{ id: 'a' }] };
    const { newState } = applyPatches(state, [
      { op: 'upsert', path: '/lineItems', key: 'id', value: { id: 'b' } },
    ]);
    expect(newState).toEqual({ lineItems: [{ id: 'a' }, { id: 'b' }] });
  });
});

describe('patches.applyPatches — atomicity (REQ-PATCH-002)', () => {
  it('input state is never mutated even after multiple ops', () => {
    const state: { items: Array<{ id: string; v: number }>; meta: { hits: number } } = {
      items: [{ id: 'a', v: 1 }],
      meta: { hits: 0 },
    };
    applyPatches(state, [
      { op: 'append', path: '/items', value: { id: 'b', v: 2 } },
      { op: 'increment', path: '/meta/hits', by: 1 },
    ]);
    expect(state.items.length).toBe(1);
    expect(state.meta.hits).toBe(0);
  });

  it('a mid-sequence failure throws and the original state is unchanged', () => {
    const state = { a: 1 };
    expect(() =>
      applyPatches(state, [
        { op: 'add', path: '/b', value: 2 },
        { op: 'remove', path: '/missing' }, // fails
      ]),
    ).toThrow(PatchApplyError);
    expect(state).toEqual({ a: 1 });
  });
});

describe('patches.applyPatches — journal (REQ-PATCH-004)', () => {
  it('journal entries carry the source tag', () => {
    const patches: Patch[] = [
      { op: 'add', path: '/x', value: 1 },
      { op: 'remove', path: '/x' },
    ];
    const { journal } = applyPatches({}, patches, 'hateoas');
    expect(journal.every((j) => j.source === 'hateoas')).toBe(true);
  });

  it('journal preserves op-specific fields', () => {
    const { journal } = applyPatches({ a: 1 }, [
      { op: 'increment', path: '/a', by: 5 },
    ]);
    expect(journal[0]).toMatchObject({ op: 'increment', path: '/a', by: 5 });
  });
});

describe('patches.parsePointer / joinPointer', () => {
  it('round-trips simple paths', () => {
    expect(joinPointer(parsePointer('/a/b/c'))).toBe('/a/b/c');
  });

  it('handles RFC 6901 escapes', () => {
    expect(parsePointer('/a~1b/c~0d')).toEqual(['a/b', 'c~d']);
    expect(joinPointer(['a/b', 'c~d'])).toBe('/a~1b/c~0d');
  });

  it('empty pointer parses to []', () => {
    expect(parsePointer('')).toEqual([]);
  });

  it('rejects pointers that do not start with /', () => {
    expect(() => parsePointer('a/b')).toThrow();
  });
});
