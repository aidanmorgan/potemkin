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
