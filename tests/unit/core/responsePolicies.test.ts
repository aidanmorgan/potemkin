import { applyPatches } from '../../../src/model/patches';
import { compileMaskValuePatches, maskValues } from '../../../src/core/responsePolicies';
import type { JsonObject } from '../../../src/contracts/value';

describe('response policy masks', () => {
  it('compiles recursive bare-field masks into patches for nested objects and arrays', () => {
    const body: JsonObject = {
      email: 'root@example.test',
      nested: {
        email: 'nested@example.test',
        items: [{ email: 'item@example.test', name: 'Item' }],
      },
    };
    const patches = compileMaskValuePatches(body, ['email']);

    expect(applyPatches(body, patches, 'mask').newState).toEqual(maskValues(body, ['email']));
    expect(patches.map((patch) => patch.path)).toEqual([
      '/email',
      '/nested/email',
      '/nested/items/0/email',
    ]);
  });

  it('compiles pointers relative to every visited object', () => {
    const body: JsonObject = {
      metadata: { secret: 'root-secret' },
      nested: {
        metadata: { secret: 'nested-secret' },
        items: [{ metadata: { secret: 'item-secret' } }],
      },
    };
    const patches = compileMaskValuePatches(body, ['/metadata/secret']);

    expect(applyPatches(body, patches, 'mask').newState).toEqual(
      maskValues(body, ['/metadata/secret']),
    );
    expect(patches.map((patch) => patch.path)).toEqual([
      '/metadata/secret',
      '/nested/metadata/secret',
      '/nested/items/0/metadata/secret',
    ]);
  });
});
