/**
 * C4 — per-boundary schema inference at boot.
 *
 * boot runs buildInferredSchema for every boundary and attaches the results as
 * BootedSystem.inferredSchemas (keyed by boundary). The CRM Opportunity
 * line-item boundary declares computed fields totalValue + itemCount; their
 * names surface in GET /_engine/state/:boundary/:id under _meta.computedFields.
 * Inference that fails to converge past the 4-iteration cap raises
 * BOOT_ERR_SCHEMA_INFERENCE_DIVERGENT.
 */

import * as path from 'node:path';

import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { createGateway } from '../../src/http/gateway.js';
import { resetSystem } from '../../src/engine/reset.js';
import { loadFixtureWithGlobal } from '../fixtures/index.js';
import { buildInferredSchema } from '../../src/dsl/schemaInference.js';
import { BootError } from '../../src/errors.js';
import {
  withPersistentServer,
  type PersistentAgent,
} from '../_support/persistentAgent.js';
import { registerFileTeardown } from '../_support/testTeardown.js';

const CRM_CONFIG = path.join(__dirname, '..', 'fixtures', 'crm', 'potemkin.yaml');

describe('C4: boot attaches per-boundary inferred schemas', () => {
  let sys: BootedSystem;
  let agent: PersistentAgent;

  beforeAll(async () => {
    const inline = await loadFixtureWithGlobal();
    sys = await bootSystem({ openapi: inline.openapi, potemkinConfigPath: CRM_CONFIG });
    const app = createGateway(sys);
    const persistent = await withPersistentServer(app);
    agent = persistent.agent;
    registerFileTeardown(persistent.close);
  });

  afterAll(() => {
    resetSystem(sys);
  });

  it('attaches an inferredSchemas entry for every boundary', () => {
    for (const b of sys.dsl.boundaries) {
      expect(sys.inferredSchemas[b.boundary]).toBeDefined();
    }
  });

  it('declares totalValue + itemCount computed fields on the line-item boundary', () => {
    const inferred = sys.inferredSchemas['OpportunityAddLineItem'];
    expect(inferred).toBeDefined();
    expect([...inferred.computedOrder].sort()).toEqual(['itemCount', 'totalValue']);
    expect(inferred.computedPaths.has('/totalValue')).toBe(true);
    expect(inferred.computedPaths.has('/itemCount')).toBe(true);
  });

  it('surfaces computed field names on GET /_engine/state/:boundary/:id', async () => {
    // Create an opportunity so the aggregate exists.
    const created = await agent
      .post('/opportunities')
      .send({ leadId: '00000000-0000-7000-8000-000000000010', value: 100 })
      .expect(201);
    const oppId = created.body.id as string;

    const res = await agent
      .get(`/_engine/state/OpportunityAddLineItem/${oppId}`)
      .expect(200);

    const computed = (res.body._meta as { computedFields: string[] }).computedFields;
    expect([...computed].sort()).toEqual(['itemCount', 'totalValue']);
  });

  it('surfaces the real reducer patch journal on GET /_engine/state/:boundary/:id (potemkin-q5d)', async () => {
    const created = await agent
      .post('/opportunities')
      .send({ leadId: '00000000-0000-7000-8000-000000000011', value: 100 })
      .expect(201);
    const oppId = created.body.id as string;

    // The addLineItem reducer appends event.payload to /lineItems — a single
    // deterministic 'reducer'-sourced append the state endpoint must surface.
    await agent
      .post(`/opportunities/${oppId}/line-items`)
      .send({ description: 'widget', quantity: 2, unitPrice: 50 })
      .expect(200);

    const res = await agent
      .get(`/_engine/state/OpportunityAddLineItem/${oppId}`)
      .expect(200);

    const journal = (res.body._meta as { patchJournal: Array<{ source: string; op: string; path: string }> })
      .patchJournal;
    const appendToLineItems = journal.find((j) => j.op === 'append' && j.path === '/lineItems');
    expect(appendToLineItems).toBeDefined();
    expect(appendToLineItems?.source).toBe('reducer');
  });
});

describe('POST /_engine/dsl: install then replay (potemkin-q5d)', () => {
  // Boots its own system because a successful install swaps sys.dsl; isolating
  // it here keeps the swap from leaking into the C4 suite above.
  let sys: BootedSystem;
  let agent: PersistentAgent;

  const minimalModule = {
    path: 'minimal.yaml',
    yaml: 'boundary: MyBoundary\ncontract_path: /my/path\nbehaviors: []\nreducers: []\nevent_catalog: []\n',
  };
  const wirePayload = { modules: [minimalModule], typescript: null, specEndpoints: [] };

  beforeAll(async () => {
    const inline = await loadFixtureWithGlobal();
    sys = await bootSystem({ openapi: inline.openapi, potemkinConfigPath: CRM_CONFIG });
    const app = createGateway(sys);
    const persistent = await withPersistentServer(app);
    agent = persistent.agent;
    registerFileTeardown(persistent.close);
  });

  // No resetSystem here: a successful install swaps sys.dsl to the minimal
  // module, so replaying the CRM baseline events against it would fail. This
  // system is isolated to this describe and torn down via the server close.

  it('returns 200 on first install with tsReducerCount drawn from the live registry', async () => {
    const res = await agent.post('/_engine/dsl').send(wirePayload).expect(200);
    expect(res.body.boundaryCount).toBe(1);
    // The wiring must read the live TS-reducer registry, not a hardcoded 0.
    expect(res.body.tsReducerCount).toBe(sys.tsReducerRegistry.snapshot().length);
    expect(typeof res.body.specVersion).toBe('string');
    expect(res.body.specVersion.length).toBeGreaterThan(0);
  });

  it('returns 304 replay when the same modules are installed again (stored specVersion matches)', async () => {
    // The stored bundle's specVersion now equals computeSpecVersion(modules), so
    // the handler short-circuits to replay instead of recompiling every time.
    const res = await agent.post('/_engine/dsl').send(wirePayload).expect(304);
    expect(res.headers['x-potemkin-spec-version']).toBeTruthy();
  });

  it('rebuilds sys.inferredSchemas on install so computed fields from a pushed boundary recompute (potemkin-xch2)', async () => {
    // Before the fix, the install swapped sys.dsl but left sys.inferredSchemas
    // (and its computedOrder) stale, so computed fields added via a push never
    // recomputed. Push a boundary that declares a computed field and assert the
    // inferred schema is rebuilt to include it.
    const before = sys.inferredSchemas;
    const computedModule = {
      path: 'computed-push.yaml',
      yaml:
        'boundary: ComputedPush\n' +
        'contract_path: /computed/push\n' +
        'behaviors: []\n' +
        'reducers: []\n' +
        'event_catalog: []\n' +
        'state:\n' +
        '  computed:\n' +
        '    - name: itemCount\n' +
        '      formula: "length(state.items)"\n' +
        '      depends_on: [items]\n',
    };
    await agent
      .post('/_engine/dsl')
      .send({ modules: [computedModule], typescript: null, specEndpoints: [] })
      .expect(200);

    // inferredSchemas must be a freshly-built object (not the stale boot one)…
    expect(sys.inferredSchemas).not.toBe(before);
    // …and must carry the computed field declared by the pushed boundary.
    const inferred = sys.inferredSchemas['ComputedPush'];
    expect(inferred).toBeDefined();
    expect([...inferred.computedOrder]).toContain('itemCount');
  });
});

describe('C4: schema inference converges and is guarded by the iteration cap', () => {
  it('converges the CRM line-item boundary without raising the divergence cap', () => {
    // The line-item boundary's event templates + reducer patches reach a fixed
    // point well within the 4-iteration cap, so buildInferredSchema returns
    // cleanly (no BOOT_ERR_SCHEMA_INFERENCE_DIVERGENT). The guard only fires on
    // a non-converging schema, which the monotone LUB lattice protects against.
    expect(() =>
      buildInferredSchema({
        boundary: 'OpportunityAddLineItem',
        events: [{ name: 'LineItemAdded', template: { description: 'command.payload.description' } }],
        reducers: [
          {
            on: 'LineItemAdded',
            patches: [{ op: 'append', path: '/lineItems', value: { id: '' } } as never],
          },
        ],
        state: {
          computed: [
            { name: 'itemCount', formula: 'length(state.lineItems)', dependsOn: ['lineItems'] },
          ],
        },
      }),
    ).not.toThrow();
  });

  it('a computed-field dependency cycle is rejected at inference time', () => {
    let caught: BootError | null = null;
    try {
      buildInferredSchema({
        boundary: 'Cycle',
        events: [],
        reducers: [],
        state: {
          computed: [
            { name: 'a', formula: 'state.b + 1', dependsOn: ['b'] },
            { name: 'b', formula: 'state.a + 1', dependsOn: ['a'] },
          ],
        },
      });
    } catch (e) {
      caught = e instanceof BootError ? e : null;
    }
    expect(caught?.code).toBe('BOOT_ERR_COMPUTED_FIELD_CYCLE');
  });
});
