import { createStateGraph, deepClone, deepMerge, deepFreeze } from '../../../src/stategraph/graph';

describe('stategraph/graph', () => {
  describe('deepClone', () => {
    it('clones a plain object', () => {
      const obj = { a: 1, b: 'x' };
      const clone = deepClone(obj);
      expect(clone).toEqual(obj);
      expect(clone).not.toBe(obj);
    });

    it('clones an array', () => {
      const arr = [1, 2, 3];
      const clone = deepClone(arr);
      expect(clone).toEqual(arr);
      expect(clone).not.toBe(arr);
    });

    it('clones nested structures', () => {
      const obj = { a: { b: { c: 42 } } };
      const clone = deepClone(obj);
      expect(clone.a.b.c).toBe(42);
      expect(clone.a).not.toBe(obj.a);
    });

    it('handles null', () => {
      expect(deepClone(null)).toBeNull();
    });

    it('handles string primitive', () => {
      expect(deepClone('hello')).toBe('hello');
    });

    it('handles number primitive', () => {
      expect(deepClone(42)).toBe(42);
    });

    it('mutation of clone does not affect original', () => {
      const obj = { a: 1 };
      const clone = deepClone(obj) as { a: number };
      clone.a = 99;
      expect(obj.a).toBe(1);
    });
  });

  describe('deepMerge', () => {
    it('merges flat objects', () => {
      const target = { a: 1, b: 2 };
      const source = { b: 99, c: 3 };
      const result = deepMerge(target, source);
      expect(result).toEqual({ a: 1, b: 99, c: 3 });
    });

    it('does not mutate target', () => {
      const target = { a: 1 };
      const source = { a: 2 };
      deepMerge(target, source);
      expect(target.a).toBe(1);
    });

    it('recursively merges nested objects', () => {
      const target = { a: { x: 1, y: 2 } };
      const source = { a: { y: 99, z: 3 } };
      const result = deepMerge(target, source);
      expect(result).toEqual({ a: { x: 1, y: 99, z: 3 } });
    });

    it('source array replaces target array (no concat)', () => {
      const target = { items: [1, 2, 3] };
      const source = { items: [10, 20] };
      const result = deepMerge(target, source);
      expect(result.items).toEqual([10, 20]);
    });

    it('source value overrides target scalar', () => {
      const target = { status: 'active' };
      const source = { status: 'closed' };
      const result = deepMerge(target, source);
      expect(result.status).toBe('closed');
    });
  });

  describe('deepFreeze', () => {
    it('freezes a plain object', () => {
      const obj = { a: 1 };
      deepFreeze(obj);
      expect(Object.isFrozen(obj)).toBe(true);
    });

    it('freezes nested objects', () => {
      const obj = { a: { b: 1 } };
      deepFreeze(obj);
      expect(Object.isFrozen(obj.a)).toBe(true);
    });

    it('freezes arrays', () => {
      const arr = [1, 2, 3];
      deepFreeze(arr);
      expect(Object.isFrozen(arr)).toBe(true);
    });

    it('handles null without throwing', () => {
      expect(() => deepFreeze(null)).not.toThrow();
    });
  });

  describe('createStateGraph', () => {
    it('starts with size 0', () => {
      const graph = createStateGraph();
      expect(graph.size()).toBe(0);
    });

    it('get returns null for unknown key', () => {
      const graph = createStateGraph();
      expect(graph.get('unknown')).toBeNull();
    });

    it('set and get round-trip', () => {
      const graph = createStateGraph();
      graph.set('id1', { status: 'active' });
      expect(graph.get('id1')).toEqual({ status: 'active' });
    });

    it('stored values are deep-frozen', () => {
      const graph = createStateGraph();
      graph.set('id1', { status: 'active' });
      const val = graph.get('id1')!;
      expect(Object.isFrozen(val)).toBe(true);
    });

    it('setting a value does not share reference with input', () => {
      const graph = createStateGraph();
      const original = { status: 'active' };
      graph.set('id1', original);
      original.status = 'mutated';
      expect(graph.get('id1')?.status).toBe('active');
    });

    it('delete removes a key', () => {
      const graph = createStateGraph();
      graph.set('id1', {});
      graph.delete('id1');
      expect(graph.get('id1')).toBeNull();
    });

    it('delete on non-existent key is a no-op', () => {
      const graph = createStateGraph();
      expect(() => graph.delete('nonexistent')).not.toThrow();
    });

    it('keys returns all stored keys', () => {
      const graph = createStateGraph();
      graph.set('a', {});
      graph.set('b', {});
      expect(graph.keys()).toContain('a');
      expect(graph.keys()).toContain('b');
    });

    it('values returns all stored objects', () => {
      const graph = createStateGraph();
      graph.set('a', { x: 1 });
      const values = graph.values();
      expect(values).toHaveLength(1);
    });

    it('entries returns [key, value] pairs', () => {
      const graph = createStateGraph();
      graph.set('k1', { val: 1 });
      const entries = graph.entries();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.[0]).toBe('k1');
    });

    it('purge clears all entries', () => {
      const graph = createStateGraph();
      graph.set('a', {});
      graph.set('b', {});
      graph.purge();
      expect(graph.size()).toBe(0);
    });

    it('size tracks number of entries', () => {
      const graph = createStateGraph();
      graph.set('a', {});
      graph.set('b', {});
      expect(graph.size()).toBe(2);
      graph.delete('a');
      expect(graph.size()).toBe(1);
    });

    it('set overwrites an existing entry', () => {
      const graph = createStateGraph();
      graph.set('a', { v: 1 });
      graph.set('a', { v: 2 });
      expect(graph.get('a')?.v).toBe(2);
    });
  });

  describe('snapshot / restore (transactional rollback)', () => {
    it('restore discards entries added after the snapshot', () => {
      const graph = createStateGraph();
      graph.set('a', { v: 1 });
      const snap = graph.snapshot();
      graph.set('b', { v: 2 });
      expect(graph.size()).toBe(2);

      graph.restore(snap);
      expect(graph.size()).toBe(1);
      expect(graph.get('a')?.v).toBe(1);
      expect(graph.get('b')).toBeNull();
    });

    it('restore reverts a value mutated after the snapshot', () => {
      const graph = createStateGraph();
      graph.set('a', { v: 1 });
      const snap = graph.snapshot();
      graph.set('a', { v: 99 });
      graph.restore(snap);
      expect(graph.get('a')?.v).toBe(1);
    });

    it('restore re-adds an entry deleted after the snapshot', () => {
      const graph = createStateGraph();
      graph.set('a', { v: 1 });
      const snap = graph.snapshot();
      graph.delete('a');
      expect(graph.get('a')).toBeNull();
      graph.restore(snap);
      expect(graph.get('a')?.v).toBe(1);
    });

    it('snapshot is not affected by later mutations (immutable capture)', () => {
      const graph = createStateGraph();
      graph.set('a', { v: 1 });
      const snap = graph.snapshot();
      graph.set('a', { v: 2 });
      graph.set('b', { v: 3 });
      // Restoring the original snapshot must reflect the captured state only.
      graph.restore(snap);
      expect(graph.get('a')?.v).toBe(1);
      expect(graph.get('b')).toBeNull();
    });
  });
});
