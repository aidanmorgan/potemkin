/**
 * 53 — TypeScript reducers fire end-to-end through Specmatic + plugin +
 * engine, via the Specmatic stub URL (NOT /_engine/forward).
 *
 * Proves through the Specmatic-served response that:
 *  - a function-style reducer() (ts-reducer fixture, scripts/widgetCreated.ts)
 *    fires when POST /widgets is dispatched through the stub: the created
 *    Widget carries status=ACTIVE + renameCount=0, which come ONLY from the TS
 *    reducer (the Widget boundary declares no YAML reducer for WidgetCreated);
 *  - a @Reducer class-decorator (ts-reducer-decorator fixture) produces the
 *    same projection end-to-end through the stub;
 *  - a YAML reducer-with-patches and a TS reducer targeting the same
 *    (boundary, event) is rejected at boot with BOOT_ERR_REDUCER_CONFLICT,
 *    naming both source locations.
 *
 * All boundary/reducer behaviour lives in the fixtures; this suite only sends
 * HTTP requests and inspects engine state via /_engine/state.
 *
 * Transport: requests target the Specmatic stub URL UNCONDITIONALLY — this
 * suite proves the Specmatic→plugin→engine forwarding path, so each stub-driven
 * describe asserts app.stubForwardingHealthy === true in beforeAll and fails
 * fast if forwarding did not warm up (no silent engineUrl fallback). The
 * conflict/boot sub-tests are transport-independent and boot the engine in-proc.
 */

import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import { bootSystem } from '../../src/engine/boot';
import { loadOpenApi } from '../../src/contract/loader';
import { compileDsl } from '../../src/dsl/parser';
import { validateReducerConflictsFromDsl } from '../../src/dsl/reducerConflict';
import { registry as sdkRegistry, type RegisteredReducer } from '../../src/sdk/index';
import { BootError } from '../../src/errors';

function javaAvailable(): boolean {
  try { execSync('java -version', { stdio: 'pipe' }); return true; } catch { return false; }
}

const describeWithJava = javaAvailable() ? describe : describe.skip;

interface WidgetState {
  id: string;
  name: string;
  status?: string;
  renameCount?: number;
}

/**
 * Base URL for boundary requests — ALWAYS the Specmatic stub. This suite proves
 * the stub→plugin→engine forwarding path, so it must never fall back to the
 * engine gateway. Stub-driven describes assert app.stubForwardingHealthy in
 * beforeAll, so reaching here implies forwarding is healthy.
 */
function target(app: E2eApp): string {
  return app.stubUrl;
}

describeWithJava('53 — TypeScript reducers fire end-to-end via Specmatic', () => {
  describe('function-style reducer() helper (ts-reducer fixture)', () => {
    let app: E2eApp;

    beforeAll(async () => {
      // The SDK registry is a process singleton; clear it before booting so a
      // prior e2e suite cannot leave a stale (boundary,event) registration.
      await sdkRegistry.reset();
      app = await startE2eApp({ fixtureName: 'ts-reducer' });
      // Fail fast: this suite proves stub→plugin→engine forwarding, so it must
      // not run if forwarding did not warm up healthy.
      expect(app.stubForwardingHealthy).toBe(true);
    }, 120_000);

    afterAll(async () => {
      if (app) await app.shutdown();
      await sdkRegistry.reset();
    }, 30_000);

    it('POST /widgets fires the TS reducer (status/renameCount come from TS)', async () => {
      const base = target(app);
      const create = await fetch(`${base}/widgets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Sprocket' }),
      });
      expect([200, 201]).toContain(create.status);
      const created = (await create.json()) as WidgetState;
      expect(created.id).toBeTruthy();
      // status + renameCount exist ONLY because the TS reducer ran — the
      // Widget boundary has no YAML reducer for WidgetCreated.
      expect(created.status).toBe('ACTIVE');
      expect(created.renameCount).toBe(0);
      expect(created.name).toBe('Sprocket');

      // Confirm the projected state persisted via the engine state endpoint
      // (the WidgetById boundary defines no GET-query behaviour, so we read
      // through /_engine/state rather than GET /widgets/{id}).
      const stateRes = await fetch(`${app.engineUrl}/_engine/state/Widget/${created.id}`);
      expect(stateRes.status).toBe(200);
      const persisted = (await stateRes.json()) as WidgetState;
      expect(persisted.status).toBe('ACTIVE');
      expect(persisted.renameCount).toBe(0);
    }, 60_000);

    it('engine /_engine/state reflects the TS-reduced Widget', async () => {
      const create = await fetch(`${target(app)}/widgets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Cog' }),
      });
      const created = (await create.json()) as WidgetState;

      const stateRes = await fetch(`${app.engineUrl}/_engine/state/Widget/${created.id}`);
      expect(stateRes.status).toBe(200);
      // GET /_engine/state merges entity fields at the top level + a _meta block.
      const bundle = (await stateRes.json()) as WidgetState & { _meta: { version: number } };
      expect(bundle.status).toBe('ACTIVE');
      expect(bundle.name).toBe('Cog');
    }, 60_000);
  });

  describe('@Reducer class-decorator (ts-reducer-decorator fixture)', () => {
    let app: E2eApp;

    beforeAll(async () => {
      await sdkRegistry.reset();
      app = await startE2eApp({ fixtureName: 'ts-reducer-decorator' });
      expect(app.stubForwardingHealthy).toBe(true);
    }, 120_000);

    afterAll(async () => {
      if (app) await app.shutdown();
      await sdkRegistry.reset();
    }, 30_000);

    it('POST /widgets fires the decorator-registered reducer', async () => {
      const create = await fetch(`${target(app)}/widgets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Gizmo' }),
      });
      expect([200, 201]).toContain(create.status);
      const created = (await create.json()) as WidgetState;
      expect(created.status).toBe('ACTIVE');
      expect(created.renameCount).toBe(0);
      expect(created.name).toBe('Gizmo');
    }, 60_000);
  });

  describe('BOOT_ERR_REDUCER_CONFLICT: YAML patches + TS target the same key', () => {
    afterEach(async () => {
      await sdkRegistry.reset();
    });

    it('boot fails when a YAML reducer-with-patches and a TS reducer collide', async () => {
      const openapi = await loadOpenApi(
        path.resolve(__dirname, '..', 'fixtures', 'ts-reducer', 'openapi', 'widgets.yaml'),
      );
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
      const tsReducers: RegisteredReducer[] = [
        { boundary: 'Widget', event: 'WidgetCreated', fn: () => [], source: 'scripts/widgetCreated.ts' },
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
      expect(caught?.message).toContain('scripts/widgetCreated.ts');
      void openapi;
    });

    it('booting the engine with a colliding fixture throws BOOT_ERR_REDUCER_CONFLICT', async () => {
      const openapi = await loadOpenApi(
        path.resolve(__dirname, '..', 'fixtures', 'ts-reducer', 'openapi', 'widgets.yaml'),
      );
      // Compile a Widget boundary that DOES carry a YAML reducer for the same
      // event the ts-reducer fixture's TS reducer owns, then boot via the
      // potemkin.yaml that scans that TS reducer → conflict at boot.
      const dsl = await compileDsl([
        {
          name: 'widget.yaml',
          yaml: `
boundary: Widget
contract_path: /widgets
identity:
  creation:
    generate: $uuidv7()
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
`,
        },
      ]);

      await sdkRegistry.reset();
      let code: string | undefined;
      try {
        await bootSystem({
          openapi,
          compiledDsl: dsl,
          typescript: {
            scan: [{ include: ['scripts/widgetCreated.ts'], exclude: [] }],
          },
          typescriptCwd: path.resolve(__dirname, '..', 'fixtures', 'ts-reducer'),
        });
      } catch (e) {
        code = e instanceof BootError ? e.code : undefined;
      }
      expect(code).toBe('BOOT_ERR_REDUCER_CONFLICT');
    });
  });
});
