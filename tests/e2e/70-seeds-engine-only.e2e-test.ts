/**
 * 70 — seeds: YAML compilation + use:-mapping path (engine-only).
 *
 * Two features from the crm-forward fixture are exercised here without a JVM:
 *
 *   seeds: — The `seeds:` forward block in potemkin.yaml is parsed and validated
 *     by the TS configSchema (validatePotemkinConfig), then compiled to
 *     CompiledSeed objects via seedCompiler (compileSeeds). At plugin time these
 *     become Specmatic stub expectations; in the engine-only path the test asserts
 *     at the seedCompiler level, proving the full TS pipeline without the JVM.
 *     This is intentional: src/dsl/configLoader.ts (lines 43-48) explicitly
 *     documents that seeds/workflow/overlay/governance forward blocks are NOT
 *     consumed by the TS engine — they are parsed directly from potemkin.yaml by
 *     the Kotlin plugin. The right layer to assert seeds in an engine-only suite
 *     is therefore the compile step, not a running HTTP endpoint.
 *
 *   use: mapping — A component file (item-entity.yaml, kind: component) is
 *     instantiated twice via a use-mapping file (simulation.yaml). The engine
 *     wires these into live boundaries (Widget at /widgets, Gadget at /gadgets).
 *     HTTP requests prove both boundaries are reachable and produce independent
 *     state with the correct initialKind values supplied via the `with:` block.
 *
 * Fixture: tests/fixtures/seeds-engine/
 *   - potemkin.yaml                     — seeds: block + module glob
 *   - dsl/components/item-entity.yaml   — kind: component (no contract_path)
 *   - dsl/simulation.yaml               — use: mapping (Widget + Gadget)
 *   - openapi/seeds-engine.yaml         — Widget + Gadget schemas
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

import { validatePotemkinConfig } from '../../src/dsl/configSchema.js';
import { compileSeeds, type SeedCompileContext } from '../../src/dsl/seedCompiler.js';
import type { PotemkinConfig } from '../../src/dsl/configSchema.js';
import { startEngineOnlyApp } from './_harness/engine-only-app';
import type { EngineOnlyApp } from './_harness/engine-only-app';
import { fwd, getAllEvents } from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

const FIXTURE_DIR = path.join(__dirname, '../fixtures/seeds-engine');

// ---------------------------------------------------------------------------
// AC1: seeds: block — TS pipeline proof (parse → validate → compile)
// ---------------------------------------------------------------------------

describe('70 — AC1: seeds: YAML compiles correctly at the seedCompiler level (no JVM)', () => {
  let config: PotemkinConfig;

  beforeAll(() => {
    const raw = yaml.load(
      fs.readFileSync(path.join(FIXTURE_DIR, 'potemkin.yaml'), 'utf8'),
    );
    config = validatePotemkinConfig(raw, { source: 'seeds-engine/potemkin.yaml' });
  });

  it('validatePotemkinConfig parses the seeds: block into two PotemkinConfigSeed entries', () => {
    expect(config.seeds).toBeDefined();
    expect(config.seeds!.length).toBe(2);
  });

  it('first seed has base: empty and targets /widgets/seeded-1', () => {
    const seed = config.seeds![0];
    expect(seed.description).toBe('seed-widget-from-empty');
    expect(seed.base).toBe('empty');
    expect(seed.request.method).toBe('GET');
    expect(seed.request.path).toBe('/widgets/seeded-1');
  });

  it('second seed has base: contract and targets /gadgets/seeded-2', () => {
    const seed = config.seeds![1];
    expect(seed.description).toBe('seed-widget-from-contract');
    expect(seed.base).toBe('contract');
    expect(seed.request.method).toBe('GET');
    expect(seed.request.path).toBe('/gadgets/seeded-2');
  });

  it('compileSeeds(base: empty) produces the patched body without a contract resolver', () => {
    const ctx: SeedCompileContext = { resolveContractBase: () => ({}) };
    const compiled = compileSeeds(config.seeds! as Parameters<typeof compileSeeds>[0], ctx);

    const emptySeed = compiled.find((s) => s.request.path === '/widgets/seeded-1');
    expect(emptySeed).toBeDefined();
    expect(emptySeed!.body).toMatchObject({ id: 'seeded-1', kind: 'ALPHA', label: 'from-empty-seed' });
    expect(emptySeed!.journal.every((j) => j.source === 'seed')).toBe(true);
  });

  it('compileSeeds(base: contract) merges patches onto the contract base', () => {
    const ctx: SeedCompileContext = {
      resolveContractBase: () => ({ id: 'contract-gen', kind: 'DEFAULT' }),
    };
    const compiled = compileSeeds(config.seeds! as Parameters<typeof compileSeeds>[0], ctx);

    const contractSeed = compiled.find((s) => s.request.path === '/gadgets/seeded-2');
    expect(contractSeed).toBeDefined();
    expect(contractSeed!.body).toMatchObject({
      id: 'seeded-2',
      kind: 'BETA',
      label: 'from-contract-seed',
    });
    expect(contractSeed!.journal.every((j) => j.source === 'seed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC2: use: mapping path — engine boots and both mapped boundaries are live
// ---------------------------------------------------------------------------

describe('70 — AC2: use:-mapped boundaries are live in the engine (no JVM)', () => {
  let app: EngineOnlyApp;

  beforeAll(async () => {
    app = await startEngineOnlyApp({ fixtureName: 'seeds-engine' });
  }, 120_000);

  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  it('Widget boundary (/widgets) is reachable — POST creates a widget with kind WIDGET', async () => {
    const res = await fwd(app.engineUrl, 'POST', '/widgets', { label: 'alpha-widget' });

    expect([200, 201]).toContain(res.status);
    const body = res.body as JsonObject;
    expect(typeof body['id']).toBe('string');
    expect((body['id'] as string).length).toBeGreaterThan(0);
    expect(body['kind']).toBe('WIDGET');
    expect(body['label']).toBe('alpha-widget');
  }, 30_000);

  it('Gadget boundary (/gadgets) is reachable — POST creates a gadget with kind GADGET', async () => {
    const res = await fwd(app.engineUrl, 'POST', '/gadgets', { label: 'beta-gadget' });

    expect([200, 201]).toContain(res.status);
    const body = res.body as JsonObject;
    expect(typeof body['id']).toBe('string');
    expect((body['id'] as string).length).toBeGreaterThan(0);
    expect(body['kind']).toBe('GADGET');
    expect(body['label']).toBe('beta-gadget');
  }, 30_000);

  it('Widget and Gadget instances are independent — mutating one does not change the other', async () => {
    const wRes = await fwd(app.engineUrl, 'POST', '/widgets', { label: 'independence-widget' });
    expect([200, 201]).toContain(wRes.status);
    const widgetId = (wRes.body as JsonObject)['id'] as string;

    const gRes = await fwd(app.engineUrl, 'POST', '/gadgets', { label: 'independence-gadget' });
    expect([200, 201]).toContain(gRes.status);
    const gadgetId = (gRes.body as JsonObject)['id'] as string;

    const patchRes = await fwd(app.engineUrl, 'PATCH', `/widgets/${widgetId}`, { label: 'updated-widget' });
    expect(patchRes.status).toBe(200);

    const events = await getAllEvents(app.engineUrl);
    const widgetCreated = events.find((e) => e.type === 'ItemCreated' && e.aggregateId === widgetId);
    const gadgetCreated = events.find((e) => e.type === 'ItemCreated' && e.aggregateId === gadgetId);
    const widgetUpdated = events.find((e) => e.type === 'ItemUpdated' && e.aggregateId === widgetId);
    const gadgetUpdated = events.find((e) => e.type === 'ItemUpdated' && e.aggregateId === gadgetId);

    expect(widgetCreated).toBeDefined();
    expect(gadgetCreated).toBeDefined();
    expect(widgetUpdated).toBeDefined();
    expect(gadgetUpdated).toBeUndefined();
  }, 30_000);

  it('component definition (ItemEntity) does not appear as a live boundary — only mapped names do', async () => {
    const wRes = await fwd(app.engineUrl, 'POST', '/widgets', { label: 'boundary-check' });
    expect([200, 201]).toContain(wRes.status);
    const gRes = await fwd(app.engineUrl, 'POST', '/gadgets', { label: 'boundary-check' });
    expect([200, 201]).toContain(gRes.status);

    const events = await getAllEvents(app.engineUrl);
    const boundaries = new Set(events.map((e) => e.boundary));

    expect(boundaries.has('Widget')).toBe(true);
    expect(boundaries.has('Gadget')).toBe(true);
    expect(boundaries.has('ItemEntity')).toBe(false);
  }, 30_000);
});
