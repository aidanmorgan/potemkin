/**
 * Tests for src/dsl/reducerConflict.ts (REQ-TS-005).
 */

import { validateReducerConflictsFromDsl } from '../../../src/dsl/reducerConflict.js';
import { compileDsl } from '../../../src/dsl/parser.js';
import { BootError } from '../../../src/errors.js';
import type { RegisteredReducer } from '../../../src/sdk/index.js';
import type { CompiledDsl } from '../../../src/dsl/types.js';

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
