import { behavior, boundary, simulation } from '../../../src/authoring/builders.js';
import {
  boundaryName,
  behaviorName,
  contractPath,
  pathSegment,
} from '../../../src/domain/references.js';

describe('removed TypeScript authoring aliases', () => {
  it.each([
    ['when', 'condition', () => behavior(behaviorName('update'))],
    [
      'event',
      'eventCatalog',
      () => boundary(boundaryName('Orders'), contractPath(pathSegment('orders'))),
    ],
    [
      'seed',
      'initialization',
      () => boundary(boundaryName('Orders'), contractPath(pathSegment('orders'))),
    ],
    ['policies', 'global', () => simulation()],
    ['helpers', 'helper', () => simulation()],
  ])('reports %s as a removed alias for %s', (alias, replacement, create) => {
    const value = create() as unknown as Record<string, (...args: never[]) => unknown>;
    expect(Object.keys(value)).not.toContain(alias);
    expect(() => value[alias]!()).toThrow(
      expect.objectContaining({
        code: 'TS_LEGACY_ALIAS',
        details: { alias, replacement },
      }),
    );
  });

  it('keeps the canonical builder members available', () => {
    expect(typeof behavior(behaviorName('update')).condition).toBe('function');
    expect(
      typeof boundary(boundaryName('Orders'), contractPath(pathSegment('orders'))).eventCatalog,
    ).toBe('function');
    expect(typeof simulation().global).toBe('function');
    expect(typeof simulation().helper).toBe('function');
  });
});
