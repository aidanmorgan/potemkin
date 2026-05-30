/**
 * C2 + C3 — TypeScript reducers.
 *
 * C2: when potemkin.yaml has a typescript: block, boot scans + registers TS
 *     reducers and cross-checks them against the YAML BEFORE binding routes.
 *     A YAML reducer and a TS reducer for the same (boundary, event) →
 *     BOOT_ERR_REDUCER_CONFLICT. A booted TS reducer dispatches at projection.
 *
 * C3: the registry is consulted FIRST; YAML patches are used only on a miss.
 *     A TS reducer's returned Patch[] flows through the same applyPatches path
 *     so YAML-only and TS-only projection of the same event produce identical
 *     state. A non-array return → RUNTIME_ERR_REDUCER_NON_ARRAY.
 */

import * as path from 'node:path';

import { bootSystem } from '../../src/engine/boot.js';
import { executeUnitOfWork } from '../../src/engine/uow.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import { projectEvent } from '../../src/engine/projection.js';
import { createStateGraph } from '../../src/stategraph/graph.js';
import { createCelEvaluator } from '../../src/cel/evaluator.js';
import { createTsReducerRegistry } from '../../src/engine/tsReducerRegistry.js';
import { registry as sdkRegistry, type RegisteredReducer } from '../../src/sdk/index.js';
import { BootError } from '../../src/errors.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import type { Command, DomainEvent } from '../../src/types.js';
import type { CompiledDsl } from '../../src/dsl/types.js';

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'ts-reducer');
const CONFIG = path.join(FIXTURE_DIR, 'potemkin.yaml');
const OPENAPI = path.join(FIXTURE_DIR, 'openapi', 'widgets.yaml');

function createWidgetCommand(name = 'Sprocket'): Command {
  const id = nextUuidv7();
  return {
    commandId: nextUuidv7(),
    boundary: 'Widget',
    intent: 'creation',
    targetId: id,
    payload: { name },
    queryParams: {},
    httpMethod: 'POST',
    path: '/widgets',
    origin: 'inbound',
    depth: 0,
  };
}

function widgetCreatedEvent(id: string, name: string): DomainEvent {
  return {
    eventId: nextUuidv7(),
    type: 'WidgetCreated',
    boundary: 'Widget',
    aggregateId: id,
    payload: { id, name },
    timestamp: '2026-01-01T00:00:00.000Z',
    sequenceVersion: 1,
    causedBy: null,
  };
}

describe('C2: TypeScript reducer scan + dispatch via potemkinConfigPath', () => {
  it('registers the TS reducer at boot', async () => {
    const openapi = await loadOpenApi(OPENAPI);
    const sys = await bootSystem({ openapi, potemkinConfigPath: CONFIG });
    expect(sys.tsReducerRegistry.hasAny()).toBe(true);
    expect(sys.tsReducerRegistry.get('Widget', 'WidgetCreated')).toBeDefined();
  });

  it('dispatches the TS reducer at projection time (state reflects TS patches)', async () => {
    const openapi = await loadOpenApi(OPENAPI);
    const sys = await bootSystem({ openapi, potemkinConfigPath: CONFIG });

    const cmd = createWidgetCommand('Sprocket');
    await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      openapi: sys.openapi,
      schemaRegistry: sys.schemaRegistry,
      tsReducerRegistry: sys.tsReducerRegistry,
      logger: sys.logger,
    });

    const state = sys.graph.get(cmd.targetId!);
    expect(state).not.toBeNull();
    // status/renameCount come only from the TS reducer, not from any YAML patch.
    expect(state!['status']).toBe('ACTIVE');
    expect(state!['renameCount']).toBe(0);
    expect(state!['name']).toBe('Sprocket');
    expect(state!['id']).toBe(cmd.targetId);
  });
});

describe('C2: BOOT_ERR_REDUCER_CONFLICT when YAML patches and TS collide', () => {
  afterEach(async () => {
    await sdkRegistry.reset();
  });

  it('throws when a TS reducer and a YAML reducer-with-patches target the same key', async () => {
    const openapi = await loadOpenApi(OPENAPI);
    // YAML boundary with a reducer-with-patches for WidgetCreated.
    const dsl = await compileDsl([
      {
        name: 'widget.yaml',
        yaml: `
boundary: Widget
contract_path: /widgets
event_catalog:
  - type: WidgetCreated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: createWidget
    match:
      operationId: createWidget
      condition: "true"
    emit: WidgetCreated
reducers:
  - on: WidgetCreated
    patches:
      - { op: replace, path: /id, value: "\${command.targetId}" }
`,
      },
    ]);
    const { validateReducerConflictsFromDsl } = await import('../../src/dsl/reducerConflict.js');
    const tsReducers: RegisteredReducer[] = [
      { boundary: 'Widget', event: 'WidgetCreated', fn: () => [], source: 'scripts/x.ts' },
    ];
    let caught: BootError | null = null;
    try {
      validateReducerConflictsFromDsl({
        dsl,
        boundarySourcePaths: { Widget: 'dsl/widget.yaml' },
        tsReducers,
      });
    } catch (e) {
      caught = e instanceof BootError ? e : null;
    }
    expect(caught?.code).toBe('BOOT_ERR_REDUCER_CONFLICT');
    expect(caught?.message).toContain('dsl/widget.yaml');
    expect(caught?.message).toContain('scripts/x.ts');
    void openapi;
  });
});

describe('C3: registry-first lookup; YAML-only equals TS-only state', () => {
  function projectWith(dsl: CompiledDsl, tsRegistry: ReturnType<typeof createTsReducerRegistry> | undefined) {
    const graph = createStateGraph();
    const cel = createCelEvaluator();
    const id = 'widget-1';
    const evt = widgetCreatedEvent(id, 'Sprocket');
    projectEvent({
      event: evt,
      boundary: dsl.byBoundaryName['Widget'],
      graph,
      cel,
      ...(tsRegistry ? { tsReducerRegistry: tsRegistry } : {}),
    });
    return graph.get(id);
  }

  it('produces identical state whether the patches come from YAML or a TS reducer', async () => {
    // YAML-only: WidgetCreated reducer carries the patches in YAML.
    const yamlDsl = await compileDsl([
      {
        name: 'widget.yaml',
        yaml: `
boundary: Widget
contract_path: /widgets
event_catalog:
  - type: WidgetCreated
    payload_template:
      id: "command.targetId"
      name: "command.payload.name"
behaviors:
  - name: createWidget
    match:
      operationId: createWidget
      condition: "true"
    emit: WidgetCreated
reducers:
  - on: WidgetCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /name, value: "\${event.payload.name}" }
      - { op: add, path: /status, value: "\${'ACTIVE'}" }
      - { op: add, path: /renameCount, value: "\${0}" }
`,
      },
    ]);

    // TS-only: same boundary with NO YAML reducer; a registered TS reducer
    // produces the same Patch[].
    const tsDsl = await compileDsl([
      {
        name: 'widget.yaml',
        yaml: `
boundary: Widget
contract_path: /widgets
event_catalog:
  - type: WidgetCreated
    payload_template:
      id: "command.targetId"
      name: "command.payload.name"
behaviors:
  - name: createWidget
    match:
      operationId: createWidget
      condition: "true"
    emit: WidgetCreated
`,
      },
    ]);
    const tsRegistry = createTsReducerRegistry([
      {
        boundary: 'Widget',
        event: 'WidgetCreated',
        source: 'scripts/widgetCreated.ts',
        fn: (_state, event) => {
          const e = event as { payload: { id: string; name: string } };
          return [
            { op: 'replace', path: '/id', value: e.payload.id },
            { op: 'replace', path: '/name', value: e.payload.name },
            { op: 'add', path: '/status', value: 'ACTIVE' },
            { op: 'add', path: '/renameCount', value: 0 },
          ];
        },
      },
    ]);

    const yamlState = projectWith(yamlDsl, undefined);
    const tsState = projectWith(tsDsl, tsRegistry);
    expect(tsState).toEqual(yamlState);
  });

  it('throws RUNTIME_ERR_REDUCER_NON_ARRAY when a TS reducer does not return an array', async () => {
    const dsl = await compileDsl([
      {
        name: 'widget.yaml',
        yaml: `
boundary: Widget
contract_path: /widgets
event_catalog:
  - type: WidgetCreated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: createWidget
    match:
      operationId: createWidget
      condition: "true"
    emit: WidgetCreated
`,
      },
    ]);
    const tsRegistry = createTsReducerRegistry([
      {
        boundary: 'Widget',
        event: 'WidgetCreated',
        source: 'scripts/bad.ts',
        fn: () => ({ not: 'an array' }) as never,
      },
    ]);
    const graph = createStateGraph();
    const cel = createCelEvaluator();
    let code: string | undefined;
    try {
      projectEvent({
        event: widgetCreatedEvent('w1', 'X'),
        boundary: dsl.byBoundaryName['Widget'],
        graph,
        cel,
        tsReducerRegistry: tsRegistry,
      });
    } catch (e) {
      code = (e as { details?: { code?: string } }).details?.code;
    }
    expect(code).toBe('RUNTIME_ERR_REDUCER_NON_ARRAY');
  });
});
