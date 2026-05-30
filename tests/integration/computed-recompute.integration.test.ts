/**
 * C5 — computed-field recompute after reducer patches.
 *
 * After the reducer patches apply, projectEvent recomputes the boundary's
 * declared computed fields (topological order) but only those whose dependsOn
 * intersects the touched paths. A formula error discards the candidate buffer
 * and rejects the event (500), preserving atomicity.
 *
 * End-to-end: appending line items to an Opportunity recomputes totalValue +
 * itemCount; an unrelated computed field is left untouched.
 */

import * as path from 'node:path';

import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { createGateway } from '../../src/http/gateway.js';
import { resetSystem } from '../../src/engine/reset.js';
import { loadFixtureWithGlobal } from '../fixtures/index.js';
import { recomputeComputedFields } from '../../src/dsl/schemaInference.js';
import {
  withPersistentServer,
  type PersistentAgent,
} from '../_support/persistentAgent.js';
import { registerFileTeardown } from '../_support/testTeardown.js';

const CRM_CONFIG = path.join(__dirname, '..', 'fixtures', 'crm', 'potemkin.yaml');

describe('C5: line-item totals recompute end-to-end', () => {
  let sys: BootedSystem;
  let agent: PersistentAgent;

  beforeAll(async () => {
    const inline = await loadFixtureWithGlobal();
    sys = await bootSystem({ openapi: inline.openapi, potemkinConfigPath: CRM_CONFIG });
    const persistent = await withPersistentServer(createGateway(sys));
    agent = persistent.agent;
    registerFileTeardown(persistent.close);
  });

  afterAll(() => {
    resetSystem(sys);
  });

  it('recomputes totalValue and itemCount as line items are appended', async () => {
    const created = await agent
      .post('/opportunities')
      .send({ leadId: '00000000-0000-7000-8000-000000000010', value: 500 })
      .expect(201);
    const oppId = created.body.id as string;

    await agent
      .post(`/opportunities/${oppId}/line-items`)
      .send({ description: 'Widget', quantity: 3, unitPrice: 10 })
      .expect(200);

    let res = await agent.get(`/opportunities/${oppId}`).expect(200);
    expect(res.body.itemCount).toBe(1);
    expect(res.body.totalValue).toBe(30);

    await agent
      .post(`/opportunities/${oppId}/line-items`)
      .send({ description: 'Gadget', quantity: 2, unitPrice: 25 })
      .expect(200);

    res = await agent.get(`/opportunities/${oppId}`).expect(200);
    expect(res.body.itemCount).toBe(2);
    expect(res.body.totalValue).toBe(30 + 50);
  });
});

describe('C5: recomputeComputedFields only touches dependents of changed paths', () => {
  it('recomputes a dependent computed but leaves an unrelated computed untouched', () => {
    const state: Record<string, unknown> = {
      lineItems: [{ lineTotal: 10 }, { lineTotal: 5 }],
      name: 'Acme',
      totalValue: 0,
      nameLength: 0,
    };
    const computed = [
      { name: 'totalValue', formula: 'sum(state.lineItems.map(i, i.lineTotal))', dependsOn: ['lineItems'] },
      { name: 'nameLength', formula: 'length(state.name)', dependsOn: ['name'] },
    ];
    const order = ['totalValue', 'nameLength'];

    let nameLengthEvaluations = 0;
    const evaluator = {
      evaluate: (formula: string, ctx: { state: Record<string, unknown> }): unknown => {
        if (formula.includes('name')) nameLengthEvaluations++;
        if (formula.includes('lineItems')) {
          const items = ctx.state['lineItems'] as { lineTotal: number }[];
          return items.reduce((s, x) => s + x.lineTotal, 0);
        }
        return (ctx.state['name'] as string).length;
      },
    };

    // Only /lineItems changed.
    recomputeComputedFields(state, computed, order, new Set(['/lineItems']), evaluator);

    expect(state['totalValue']).toBe(15);
    // nameLength depends on `name`, which was not touched → never recomputed.
    expect(nameLengthEvaluations).toBe(0);
    expect(state['nameLength']).toBe(0);
  });
});

describe('C5: a computed-field formula error aborts the event with 500 (atomicity)', () => {
  let sys: BootedSystem;
  let agent: PersistentAgent;

  beforeAll(async () => {
    const inline = await loadFixtureWithGlobal();
    sys = await bootSystem({ openapi: inline.openapi, potemkinConfigPath: CRM_CONFIG });
    // Inject a computed field whose formula throws at runtime onto the
    // line-item boundary's inferred schema + DSL so recompute fails.
    const boundary = sys.dsl.byBoundaryName['OpportunityAddLineItem'];
    const computed = [
      ...(boundary.state?.computed ?? []),
      { name: 'boom', formula: 'sum(state.lineItems)', dependsOn: ['lineItems'] },
    ];
    (boundary as { state?: { computed: unknown } }).state = { computed };
    const inferred = sys.inferredSchemas['OpportunityAddLineItem'];
    (inferred as unknown as { computedOrder: readonly string[] }).computedOrder = [
      ...inferred.computedOrder,
      'boom',
    ];
    const persistent = await withPersistentServer(createGateway(sys));
    agent = persistent.agent;
    registerFileTeardown(persistent.close);
  });

  afterAll(() => {
    resetSystem(sys);
  });

  it('rejects the line-item add and leaves state unchanged', async () => {
    const created = await agent
      .post('/opportunities')
      .send({ leadId: '00000000-0000-7000-8000-000000000010', value: 500 })
      .expect(201);
    const oppId = created.body.id as string;

    // sum() over an array of objects (not numbers) throws CEL_TYPE_ERROR → 500.
    await agent
      .post(`/opportunities/${oppId}/line-items`)
      .send({ description: 'Widget', quantity: 1, unitPrice: 10 })
      .expect(500);

    // Atomicity: the failed event did not append a line item.
    const res = await agent.get(`/opportunities/${oppId}`).expect(200);
    expect(res.body.lineItems ?? []).toHaveLength(0);
  });
});
