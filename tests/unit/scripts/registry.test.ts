import { buildCompositeScriptRegistry } from '../../../src/scripts/registry.js';

describe('buildCompositeScriptRegistry — scanned @Script resolution', () => {
  const scanned = [
    { id: 'shared', source: 'class:Shared', fn: () => 'SCANNED' as unknown },
    { id: 'onlyScanned', source: 'class:OnlyScanned', fn: () => 'SCANNED_ONLY' as unknown },
  ];

  it('resolves a scanned @Script by its global id', () => {
    const composite = buildCompositeScriptRegistry(scanned);
    const handle = composite.get('AnyBoundary', 'onlyScanned');
    expect(handle).toBeDefined();
    expect(handle!.source).toBe('class:OnlyScanned');
  });

  it('returns undefined when the id matches no scanned script', () => {
    const composite = buildCompositeScriptRegistry(scanned);
    expect(composite.get('B', 'missing')).toBeUndefined();
  });

  it('has() reflects the same resolution as get()', () => {
    const composite = buildCompositeScriptRegistry(scanned);
    expect(composite.has('B', 'onlyScanned')).toBe(true);
    expect(composite.has('B', 'missing')).toBe(false);
  });

  it('size() returns the count of scanned scripts', () => {
    const composite = buildCompositeScriptRegistry(scanned);
    expect(composite.size()).toBe(scanned.length);
  });
});
