/**
 * Tests for src/dsl/reducerConflict.ts (REQ-TS-005).
 */

import { validateReducerConflicts } from '../../../src/dsl/reducerConflict.js';
import { BootError } from '../../../src/errors.js';
import type { BoundaryModule } from '../../../src/dsl/configSchema.js';
import type { RegisteredReducer } from '../../../src/sdk/index.js';

function makeBoundary(name: string, events: string[]): BoundaryModule {
  return {
    boundary: name,
    specId: 'x',
    contractPath: '/x',
    events: events.map((e) => ({ name: e })),
  } as unknown as BoundaryModule;
}

function makeYamlReducer(
  boundary: string,
  events: { on: string; hasPatches?: boolean; implementation?: 'typescript' }[],
): { path: string; boundary: BoundaryModule } {
  const b = makeBoundary(boundary, events.map((e) => e.on));
  const reducers = events.map((e) => ({
    on: e.on,
    ...(e.hasPatches ? { patches: [{ op: 'replace', path: '/x', value: 'y' } as never] } : {}),
    ...(e.implementation ? { implementation: e.implementation } : {}),
  }));
  return {
    path: `/dsl/${boundary.toLowerCase()}.yaml`,
    boundary: { ...b, reducers } as BoundaryModule,
  };
}

function tsReducer(boundary: string, event: string, source = 'ts'): RegisteredReducer {
  return { boundary, event, fn: () => [], source };
}

function asBootError(e: unknown): BootError | null {
  return e instanceof BootError ? e : null;
}

function expectCode(fn: () => unknown, code: string): void {
  let caught: BootError | null = null;
  try {
    fn();
  } catch (e) {
    caught = asBootError(e);
  }
  expect(caught?.code).toBe(code);
}

describe('validateReducerConflicts — cross-reference', () => {
  it('throws BOOT_ERR_UNKNOWN_BOUNDARY when a TS reducer points at an unknown boundary', () => {
    expectCode(
      () =>
        validateReducerConflicts({
          modules: [],
          tsReducers: [tsReducer('Ghost', 'GhostCreated')],
        }),
      'BOOT_ERR_UNKNOWN_BOUNDARY',
    );
  });

  it('throws BOOT_ERR_UNKNOWN_EVENT when a TS reducer points at an undeclared event', () => {
    const modules = [{ path: '/dsl/lead.yaml', boundary: makeBoundary('Lead', ['LeadCreated']) }];
    expectCode(
      () =>
        validateReducerConflicts({
          modules,
          tsReducers: [tsReducer('Lead', 'NotARealEvent')],
        }),
      'BOOT_ERR_UNKNOWN_EVENT',
    );
  });

  it('passes when every TS reducer references a known (boundary, event)', () => {
    const modules = [{ path: '/dsl/lead.yaml', boundary: makeBoundary('Lead', ['LeadCreated']) }];
    expect(() =>
      validateReducerConflicts({
        modules,
        tsReducers: [tsReducer('Lead', 'LeadCreated')],
      }),
    ).not.toThrow();
  });
});

describe('validateReducerConflicts — conflict detection', () => {
  it('throws BOOT_ERR_REDUCER_CONFLICT when YAML patches AND TS reducer exist for the same key', () => {
    const modules = [
      makeYamlReducer('Lead', [{ on: 'LeadCreated', hasPatches: true }]),
    ];
    expectCode(
      () =>
        validateReducerConflicts({
          modules,
          tsReducers: [tsReducer('Lead', 'LeadCreated')],
        }),
      'BOOT_ERR_REDUCER_CONFLICT',
    );
  });

  it('allows YAML implementation: typescript paired with a matching TS reducer', () => {
    const modules = [
      makeYamlReducer('Lead', [{ on: 'LeadCreated', implementation: 'typescript' }]),
    ];
    expect(() =>
      validateReducerConflicts({
        modules,
        tsReducers: [tsReducer('Lead', 'LeadCreated')],
      }),
    ).not.toThrow();
  });

  it('throws BOOT_ERR_REDUCER_MISSING when implementation: typescript has no TS reducer', () => {
    const modules = [
      makeYamlReducer('Lead', [{ on: 'LeadCreated', implementation: 'typescript' }]),
    ];
    expectCode(
      () =>
        validateReducerConflicts({
          modules,
          tsReducers: [],
        }),
      'BOOT_ERR_REDUCER_MISSING',
    );
  });
});
