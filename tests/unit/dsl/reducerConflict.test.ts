/**
 * Tests for src/dsl/reducerConflict.ts (REQ-TS-005).
 */

import { validateReducerConflicts, validateReducerConflictsFromDsl } from '../../../src/dsl/reducerConflict.js';
import { compileDsl } from '../../../src/dsl/parser.js';
import { BootError } from '../../../src/errors.js';
import type { BoundaryModule } from '../../../src/dsl/configSchema.js';
import type { RegisteredReducer } from '../../../src/sdk/index.js';
import type { CompiledDsl } from '../../../src/dsl/types.js';

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

// ── Helper: compile a minimal boundary DSL with given reducers ────────────────

const MINIMAL_BOUNDARY_YAML = (reducerYaml: string) => `
boundary: Lead
contract_path: /leads
event_catalog:
  - type: LeadCreated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: createLead
    match:
      operationId: createLead
      condition: "true"
    emit: LeadCreated
reducers:
${reducerYaml}
`;

async function compileBoundaryDsl(reducerYaml: string): Promise<CompiledDsl> {
  return compileDsl([{ name: 'lead.yaml', yaml: MINIMAL_BOUNDARY_YAML(reducerYaml) }]);
}

describe('validateReducerConflictsFromDsl — implementation: typescript', () => {
  async function expectDslCode(
    reducerYaml: string,
    tsReducers: RegisteredReducer[],
    code: string,
  ): Promise<void> {
    const dsl = await compileBoundaryDsl(reducerYaml);
    let caught: BootError | null = null;
    try {
      validateReducerConflictsFromDsl({
        dsl,
        boundarySourcePaths: { Lead: '/dsl/lead.yaml' },
        tsReducers,
      });
    } catch (e) {
      caught = e instanceof BootError ? e : null;
    }
    expect(caught?.code).toBe(code);
  }

  it('throws BOOT_ERR_REDUCER_MISSING when implementation: typescript has no registered TS reducer', async () => {
    await expectDslCode(
      '  - on: LeadCreated\n    implementation: typescript',
      [],
      'BOOT_ERR_REDUCER_MISSING',
    );
  });

  it('boots fine when implementation: typescript has a matching registered TS reducer', async () => {
    const dsl = await compileBoundaryDsl('  - on: LeadCreated\n    implementation: typescript');
    expect(() =>
      validateReducerConflictsFromDsl({
        dsl,
        boundarySourcePaths: { Lead: '/dsl/lead.yaml' },
        tsReducers: [{ boundary: 'Lead', event: 'LeadCreated', fn: () => [], source: 'scripts/lead.ts' }],
      }),
    ).not.toThrow();
  });

  it('boots fine when a patches reducer (no implementation) has no TS reducer', async () => {
    const dsl = await compileBoundaryDsl(
      '  - on: LeadCreated\n    patches:\n      - { op: replace, path: /id, value: "${event.payload.id}" }',
    );
    expect(() =>
      validateReducerConflictsFromDsl({
        dsl,
        boundarySourcePaths: { Lead: '/dsl/lead.yaml' },
        tsReducers: [],
      }),
    ).not.toThrow();
  });
});
