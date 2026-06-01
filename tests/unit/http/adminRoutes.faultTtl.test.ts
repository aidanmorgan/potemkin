/**
 * Admin routes — dynamic fault TTL tests
 *
 * Verifies:
 *  1. POST /_admin/faults with ttlMs registers a fault that disappears after expiry.
 *  2. POST /_admin/faults with expiresAt (epoch ms) registers a fault with TTL.
 *  3. A fault registered without ttlMs/expiresAt persists (existing behaviour).
 */

import { createGateway } from '../../../src/http/gateway.js';
import { bootSystem, type BootedSystem } from '../../../src/engine/boot.js';
import { loadOpenApi } from '../../../src/contract/loader.js';
import { compileDsl } from '../../../src/dsl/parser.js';
import { resetSystem } from '../../../src/engine/reset.js';
import {
  withPersistentServer,
  type PersistentAgent,
  type PersistentServer,
} from '../../_support/persistentAgent.js';

// ── Minimal fixture ───────────────────────────────────────────────────────────

const MINIMAL_OPENAPI = `
openapi: "3.0.3"
info:
  title: Fault TTL Test
  version: "1.0.0"
paths:
  /items:
    get:
      operationId: listItems
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/Item"
components:
  schemas:
    Item:
      type: object
      properties:
        id:
          type: string
`;

const ITEM_DSL = `
boundary: Item
contract_path: /items
fallback_override: true
event_catalog: []
behaviors: []
reducers: []
`;

const VALID_FAULT_RULE = {
  name: 'test-fault',
  match: { condition: 'true' },
  response: { status: 503, body: { error: 'DOWN' } },
};

describe('adminRoutes — fault TTL via POST /_admin/faults', () => {
  let sys: BootedSystem;
  let agent: PersistentAgent;
  let persistent: PersistentServer;

  beforeAll(async () => {
    const openapi = await loadOpenApi(MINIMAL_OPENAPI);
    sys = await bootSystem({
      openapi,
      compiledDsl: await compileDsl([{ name: 'item', yaml: ITEM_DSL }]),
    });
    persistent = await withPersistentServer(createGateway(sys));
    agent = persistent.agent;
  });

  afterAll(async () => {
    await persistent.close();
  });

  afterEach(() => {
    resetSystem(sys);
    jest.useRealTimers();
  });

  // ── 1. ttlMs: fault disappears after simulated expiry ─────────────────────

  it('fault registered with ttlMs is listed before expiry', async () => {
    const res = await agent
      .post('/_admin/faults')
      .send({ ...VALID_FAULT_RULE, ttlMs: 60_000 })
      .expect(201);

    expect(res.body.id).toBeDefined();
    expect(typeof res.body.ttlSeconds).toBe('number');

    const listRes = await agent.get('/_admin/faults').expect(200);
    const ids = listRes.body.map((e: { id: string }) => e.id);
    expect(ids).toContain(res.body.id);
  });

  it('fault registered with ttlMs disappears after expiry via faultStore.list()', async () => {
    // Use faultStore directly to assert TTL pruning behaviour without real sleep.
    const id = sys.faultStore.add(VALID_FAULT_RULE, 0.001); // 1 ms TTL

    // Brief real delay so Date.now() advances past the expiry.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const listed = sys.faultStore.list().map((e) => e.id);
    expect(listed).not.toContain(id);
  });

  it('fault registered with expiresAt in the past is ignored (no TTL set, fault persists)', async () => {
    // expiresAt in the past — the guard `expiresAt > Date.now()` does not hold, so
    // no TTL is applied: the fault is registered without an expiry and persists.
    const pastExpiresAt = Date.now() - 10_000; // 10 s in the past
    const res = await agent
      .post('/_admin/faults')
      .send({ ...VALID_FAULT_RULE, expiresAt: pastExpiresAt })
      .expect(201);

    // No TTL was set (guard filtered the past timestamp)
    expect(res.body.ttlSeconds).toBeUndefined();

    // The fault is still listed
    const listRes = await agent.get('/_admin/faults').expect(200);
    const ids = listRes.body.map((e: { id: string }) => e.id);
    expect(ids).toContain(res.body.id);
  });

  it('fault registered with future expiresAt is listed', async () => {
    const futureExpiresAt = Date.now() + 60_000;
    const res = await agent
      .post('/_admin/faults')
      .send({ ...VALID_FAULT_RULE, expiresAt: futureExpiresAt })
      .expect(201);

    expect(res.body.id).toBeDefined();
    const listRes = await agent.get('/_admin/faults').expect(200);
    const ids = listRes.body.map((e: { id: string }) => e.id);
    expect(ids).toContain(res.body.id);
  });

  // ── 2. No TTL: fault persists (existing behaviour) ─────────────────────────

  it('fault registered without ttlMs/expiresAt persists indefinitely', async () => {
    const res = await agent
      .post('/_admin/faults')
      .send(VALID_FAULT_RULE)
      .expect(201);

    expect(res.body.ttlSeconds).toBeUndefined();

    const listRes = await agent.get('/_admin/faults').expect(200);
    const ids = listRes.body.map((e: { id: string }) => e.id);
    expect(ids).toContain(res.body.id);
  });

  // ── 3. ttlMs=0 is ignored (non-positive TTL treated as no-TTL) ────────────

  it('fault registered with ttlMs=0 does not set a TTL', async () => {
    const res = await agent
      .post('/_admin/faults')
      .send({ ...VALID_FAULT_RULE, ttlMs: 0 })
      .expect(201);

    // ttlMs=0 is not > 0, so no TTL should be applied
    expect(res.body.ttlSeconds).toBeUndefined();
  });
});
