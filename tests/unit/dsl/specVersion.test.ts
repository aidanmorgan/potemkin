import { computeSpecVersion } from '../../../src/dsl/specVersion.js';

describe('computeSpecVersion', () => {
  it('is deterministic for identical inputs', () => {
    const mods = [
      { path: 'a.yaml', yaml: 'boundary: A\n' },
      { path: 'b.yaml', yaml: 'boundary: B\n' },
    ];
    expect(computeSpecVersion(mods)).toBe(computeSpecVersion(mods));
  });

  it('is order-independent — sorted by path before hashing', () => {
    const ab = [
      { path: 'a.yaml', yaml: 'boundary: A\n' },
      { path: 'b.yaml', yaml: 'boundary: B\n' },
    ];
    const ba = [
      { path: 'b.yaml', yaml: 'boundary: B\n' },
      { path: 'a.yaml', yaml: 'boundary: A\n' },
    ];
    expect(computeSpecVersion(ab)).toBe(computeSpecVersion(ba));
  });

  it('produces a different hash when a single byte differs', () => {
    const a = [{ path: 'a.yaml', yaml: 'boundary: A\n' }];
    const b = [{ path: 'a.yaml', yaml: 'boundary: A \n' }];
    expect(computeSpecVersion(a)).not.toBe(computeSpecVersion(b));
  });

  it('emits 64 hex characters (SHA-256)', () => {
    expect(computeSpecVersion([{ path: 'x.yaml', yaml: '' }])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('an empty modules list emits a stable hash', () => {
    expect(computeSpecVersion([])).toMatch(/^[0-9a-f]{64}$/);
  });
});
