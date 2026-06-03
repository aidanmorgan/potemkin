import { buildCompositeScriptRegistry } from '../../../src/scripts/registry.js';
import type { ScriptRegistry } from '../../../src/scripts/types.js';

describe('buildCompositeScriptRegistry — scanned @Script resolution', () => {
  const scanned = [
    { id: 'shared', source: 'class:Shared', fn: () => 'SCANNED' as unknown },
    { id: 'onlyScanned', source: 'class:OnlyScanned', fn: () => 'SCANNED_ONLY' as unknown },
  ];

  it('an inline registry shadows a scanned @Script with the same name (inline wins)', () => {
    const inlineHandle = {
      name: 'shared',
      boundary: 'B',
      source: 'inline-source',
      fn: () => 'INLINE' as unknown,
    };
    const inlineRegistry: ScriptRegistry = {
      get: (b, n) => (b === 'B' && n === 'shared' ? inlineHandle : undefined),
      has: (b, n) => b === 'B' && n === 'shared',
      size: () => 1,
    };
    const composite = buildCompositeScriptRegistry(inlineRegistry, scanned);
    const handle = composite.get('B', 'shared');
    expect(handle).toBeDefined();
    expect(handle!.source).not.toMatch(/^class:/);
    expect(handle!.source).toBe('inline-source');
  });

  it('falls back to the scanned @Script by global id when there is no inline script', () => {
    const composite = buildCompositeScriptRegistry(undefined, scanned);
    const handle = composite.get('AnyBoundary', 'onlyScanned');
    expect(handle).toBeDefined();
    expect(handle!.source).toBe('class:OnlyScanned');
  });

  it('returns undefined when the id matches neither inline nor scanned', () => {
    const composite = buildCompositeScriptRegistry(undefined, scanned);
    expect(composite.get('B', 'missing')).toBeUndefined();
  });

  it('has() reflects the same resolution as get()', () => {
    const composite = buildCompositeScriptRegistry(undefined, scanned);
    expect(composite.has('B', 'onlyScanned')).toBe(true);
    expect(composite.has('B', 'missing')).toBe(false);
  });

  it('size() returns count of scanned scripts when no inline registry', () => {
    const composite = buildCompositeScriptRegistry(undefined, scanned);
    expect(composite.size()).toBe(scanned.length);
  });
});
