import { createShadowGraph } from '../../../src/stategraph/shadow';
import { createStateGraph } from '../../../src/stategraph/graph';

describe('stategraph/shadow', () => {
  describe('get', () => {
    it('returns null when no staged value and global has none', () => {
      const global = createStateGraph();
      const shadow = createShadowGraph(global);
      expect(shadow.get('id1')).toBeNull();
    });

    it('returns staged value when staged', () => {
      const global = createStateGraph();
      const shadow = createShadowGraph(global);
      shadow.stage('id1', { status: 'staged' });
      expect(shadow.get('id1')).toEqual({ status: 'staged' });
    });

    it('falls through to global when not staged', () => {
      const global = createStateGraph();
      global.set('id1', { status: 'global' });
      const shadow = createShadowGraph(global);
      expect(shadow.get('id1')).toEqual({ status: 'global' });
    });

    it('clones global value so caller can mutate without affecting global', () => {
      const global = createStateGraph();
      global.set('id1', { count: 1 });
      const shadow = createShadowGraph(global);
      const val = shadow.get('id1') as { count: number };
      val.count = 999;
      expect(global.get('id1')?.count).toBe(1);
    });

    it('staged value wins over global', () => {
      const global = createStateGraph();
      global.set('id1', { status: 'global' });
      const shadow = createShadowGraph(global);
      shadow.stage('id1', { status: 'staged' });
      expect(shadow.get('id1')?.status).toBe('staged');
    });
  });

  describe('stage', () => {
    it('stages a clone of the provided value', () => {
      const global = createStateGraph();
      const shadow = createShadowGraph(global);
      const original = { status: 'original' };
      shadow.stage('id1', original);
      original.status = 'mutated';
      expect(shadow.get('id1')?.status).toBe('original');
    });

    it('overwrites a previous staged value', () => {
      const global = createStateGraph();
      const shadow = createShadowGraph(global);
      shadow.stage('id1', { v: 1 });
      shadow.stage('id1', { v: 2 });
      expect(shadow.get('id1')?.v).toBe(2);
    });
  });

  describe('has', () => {
    it('returns false when neither staged nor in global', () => {
      const global = createStateGraph();
      const shadow = createShadowGraph(global);
      expect(shadow.has('id1')).toBe(false);
    });

    it('returns true when staged', () => {
      const global = createStateGraph();
      const shadow = createShadowGraph(global);
      shadow.stage('id1', {});
      expect(shadow.has('id1')).toBe(true);
    });

    it('returns true when present in global', () => {
      const global = createStateGraph();
      global.set('id1', {});
      const shadow = createShadowGraph(global);
      expect(shadow.has('id1')).toBe(true);
    });
  });

  describe('shadowed', () => {
    it('returns empty map initially', () => {
      const global = createStateGraph();
      const shadow = createShadowGraph(global);
      expect(shadow.shadowed().size).toBe(0);
    });

    it('returns staged entries', () => {
      const global = createStateGraph();
      const shadow = createShadowGraph(global);
      shadow.stage('id1', { x: 1 });
      expect(shadow.shadowed().size).toBe(1);
      expect(shadow.shadowed().get('id1')).toEqual({ x: 1 });
    });
  });

  describe('commitInto', () => {
    it('writes staged entries into the target graph', () => {
      const global = createStateGraph();
      const shadow = createShadowGraph(global);
      shadow.stage('id1', { committed: true });
      const target = createStateGraph();
      shadow.commitInto(target);
      expect(target.get('id1')).toEqual({ committed: true });
    });

    it('clears staged entries after commit', () => {
      const global = createStateGraph();
      const shadow = createShadowGraph(global);
      shadow.stage('id1', {});
      shadow.commitInto(global);
      expect(shadow.shadowed().size).toBe(0);
    });

    it('commits multiple staged entries', () => {
      const global = createStateGraph();
      const shadow = createShadowGraph(global);
      shadow.stage('a', { v: 1 });
      shadow.stage('b', { v: 2 });
      shadow.commitInto(global);
      expect(global.get('a')).toEqual({ v: 1 });
      expect(global.get('b')).toEqual({ v: 2 });
    });

    it('does not commit global entries that were not staged', () => {
      const global = createStateGraph();
      global.set('existing', { v: 9 });
      const shadow = createShadowGraph(global);
      const target = createStateGraph();
      shadow.commitInto(target);
      expect(target.get('existing')).toBeNull();
    });
  });
});
