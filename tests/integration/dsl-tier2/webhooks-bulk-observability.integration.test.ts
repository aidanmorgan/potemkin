/**
 * Integration tests for three previously-inert engine features, driven end-to-end
 * through the HTTP gateway:
 *
 *  1. Webhook dispatch — a committed event matching a webhook subscription fires a
 *     signed delivery via the injected transport; X-Potemkin-Skip-Webhooks suppresses it.
 *  2. Bulk-transactional side-effect deferral — a rolled-back bulk batch leaves NO
 *     saga/webhook side-effects; a successful batch fires them once after commit.
 *  3. Observability controls — X-Potemkin-Log-Level overrides the request logger level
 *     and X-Potemkin-Metric-Tag is attached to recorded metrics.
 *
 * Side-effects are inherently fire-and-forget (non-blocking). The tests await a
 * microtask drain so the deferred deliveries/saga runs complete before assertions.
 */

import { bootSystem, type BootedSystem, type BootInput } from '../../../src/engine/boot.js';
import { createGateway } from '../../../src/http/gateway.js';
import { resetSystem } from '../../../src/engine/reset.js';
import { compileDsl } from '../../../src/dsl/parser.js';
import { loadOpenApi } from '../../../src/contract/loader.js';
import { createEngineMetrics } from '../../../src/observability/metrics.js';
import { createLogger } from '../../../src/observability/logger.js';
import type { Attributes } from '@opentelemetry/api';
import type { FetchLike } from '../../../src/webhooks/dispatcher.js';
import { WEBHOOK_SIGNATURE_HEADER } from '../../../src/webhooks/dispatcher.js';
import {
  withPersistentServer,
  type PersistentAgent,
  type PersistentServer,
} from '../../_support/persistentAgent.js';

const WEBHOOK_SECRET = 'integration-test-secret';

const OPENAPI_YAML = `
openapi: '3.0.3'
info:
  title: Orders
  version: '1.0.0'
paths:
  /orders:
    post:
      operationId: createOrder
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Order'
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Order'
components:
  schemas:
    Order:
      type: object
      additionalProperties: true
      required: [sku]
      properties:
        id:
          type: string
        sku:
          type: string
`;

const ORDER_DSL = `
boundary: Order
contract_path: /orders
fallback_override: true
identity:
  creation:
    generate: $uuidv7()
behaviors: []
reducers: []
event_catalog: []
`;

// A webhook on every Order creation event + a saga that appends a __saga__ event.
const GLOBAL_YAML = `
sagas:
  - name: OrderFulfilment
    trigger:
      boundary: Order
      intent: creation
      condition: "true"
    steps:
      - name: noop
        boundary: Order
        intent: mutation
        operationId: createOrder
        target_id: '"nonexistent-target"'
        payload:
          touched: "true"

webhooks:
  - name: order-created-webhook
    trigger:
      boundary: Order
      intent: creation
      condition: "true"
    url: "'http://127.0.0.1:1/order-hook'"
    secret: "${WEBHOOK_SECRET}"
    payload:
      orderId: "\${event.aggregateId}"
      eventType: "\${event.type}"
    retry:
      maxAttempts: 1
`;

interface RecordedDelivery {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** A fake webhook transport that records every delivery and always reports success. */
function makeRecordingTransport(): { transport: FetchLike; deliveries: RecordedDelivery[] } {
  const deliveries: RecordedDelivery[] = [];
  const transport: FetchLike = async (url, init) => {
    deliveries.push({ url, headers: init.headers, body: init.body });
    return { ok: true, status: 200 };
  };
  return { transport, deliveries };
}

/** Drain pending microtasks so fire-and-forget side-effects settle before assertions. */
async function drain(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

async function bootOrders(extra: Partial<BootInput>): Promise<BootedSystem> {
  const openapi = await loadOpenApi(OPENAPI_YAML);
  const compiledDsl = await compileDsl([{ name: 'order', yaml: ORDER_DSL }], GLOBAL_YAML);
  return bootSystem({ openapi, compiledDsl, ...extra });
}

function sagaEventCount(sys: BootedSystem): number {
  return sys.events.all().filter((e) => e.boundary === '__saga__').length;
}

describe('Tier-2 webhook dispatch (potemkin-422)', () => {
  let sys: BootedSystem;
  let agent: PersistentAgent;
  let persistent: PersistentServer;
  let deliveries: RecordedDelivery[];

  beforeAll(async () => {
    const rec = makeRecordingTransport();
    deliveries = rec.deliveries;
    sys = await bootOrders({ webhookTransport: rec.transport });
    persistent = await withPersistentServer(createGateway(sys));
    agent = persistent.agent;
  });

  afterAll(async () => {
    await persistent.close();
  });

  beforeEach(() => {
    resetSystem(sys);
    deliveries.length = 0;
  });

  it('a committed event matching a subscription fires a signed delivery via the injected transport', async () => {
    const res = await agent.post('/orders').send({ sku: 'WIDGET-1' });
    expect(res.status).toBe(201);
    await drain();

    expect(deliveries).toHaveLength(1);
    const delivery = deliveries[0]!;
    expect(delivery.url).toBe('http://127.0.0.1:1/order-hook');

    // Body is the templated payload; signature is the HMAC-SHA256 of that body.
    const payload = JSON.parse(delivery.body) as { orderId: string; eventType: string };
    expect(typeof payload.orderId).toBe('string');
    expect(payload.orderId.length).toBeGreaterThan(0);

    const signature = delivery.headers[WEBHOOK_SIGNATURE_HEADER];
    expect(typeof signature).toBe('string');
    const { createHmac } = await import('node:crypto');
    const expected = createHmac('sha256', WEBHOOK_SECRET).update(delivery.body).digest('hex');
    expect(signature).toBe(expected);
  });

  it('X-Potemkin-Skip-Webhooks: true suppresses delivery for the request', async () => {
    const res = await agent
      .post('/orders')
      .set('X-Potemkin-Skip-Webhooks', 'true')
      .send({ sku: 'WIDGET-2' });
    expect(res.status).toBe(201);
    await drain();

    expect(deliveries).toHaveLength(0);
  });
});

describe('Tier-2 bulk-transactional side-effect deferral (potemkin-1t0)', () => {
  let sys: BootedSystem;
  let agent: PersistentAgent;
  let persistent: PersistentServer;
  let deliveries: RecordedDelivery[];

  beforeAll(async () => {
    const rec = makeRecordingTransport();
    deliveries = rec.deliveries;
    sys = await bootOrders({ webhookTransport: rec.transport });
    persistent = await withPersistentServer(createGateway(sys));
    agent = persistent.agent;
  });

  afterAll(async () => {
    await persistent.close();
  });

  beforeEach(() => {
    resetSystem(sys);
    deliveries.length = 0;
  });

  it('a rolled-back bulk batch leaves NO saga or webhook side-effects', async () => {
    const sagaBefore = sagaEventCount(sys);

    // Second item is invalid (missing required `sku`) → whole batch aborts.
    const res = await agent
      .post('/orders')
      .set('X-Potemkin-Bulk-Transactional', 'true')
      .send([{ sku: 'OK-1' }, { notSku: 'bad' }]);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('BULK_TRANSACTION_ABORTED');
    await drain();

    // No webhook fired and no new saga event was appended.
    expect(deliveries).toHaveLength(0);
    expect(sagaEventCount(sys)).toBe(sagaBefore);
  });

  it('a successful bulk batch fires saga + webhook side-effects once per item after commit', async () => {
    const sagaBefore = sagaEventCount(sys);

    const res = await agent
      .post('/orders')
      .set('X-Potemkin-Bulk-Transactional', 'true')
      .send([{ sku: 'OK-1' }, { sku: 'OK-2' }]);

    expect(res.status).toBe(201);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    await drain();

    // One webhook delivery per committed item.
    expect(deliveries).toHaveLength(2);
    // Saga fired once per item: each run appends a SagaStarted event.
    const started = sys.events
      .all()
      .filter((e) => e.boundary === '__saga__' && e.type === 'SagaStarted').length;
    expect(started).toBe(2);
    expect(sagaEventCount(sys)).toBeGreaterThan(sagaBefore);
  });
});

describe('Tier-6 observability controls (potemkin-1eg)', () => {
  it('X-Potemkin-Metric-Tag attaches the tag to recorded engine metrics', async () => {
    // Capture metric attribute sets by wrapping a real EngineMetrics counter.
    const base = createEngineMetrics();
    const observed: Array<Record<string, unknown>> = [];
    const metrics = {
      ...base,
      commandsTotal: {
        add: (value: number, attrs?: Attributes) => {
          observed.push((attrs ?? {}) as Record<string, unknown>);
          base.commandsTotal.add(value, attrs);
        },
      } as typeof base.commandsTotal,
    };

    const sys = await bootOrders({ metrics });
    const persistent = await withPersistentServer(createGateway(sys));
    try {
      const res = await persistent.agent
        .post('/orders')
        .set('X-Potemkin-Metric-Tag', 'tenant=acme')
        .send({ sku: 'WIDGET-3' });
      expect(res.status).toBe(201);

      // The commandsTotal increment for this request carries the tag dimension.
      expect(observed.some((a) => a['tenant'] === 'acme')).toBe(true);
    } finally {
      await persistent.close();
    }
  });

  it('X-Potemkin-Log-Level: debug round-trips through the gateway without error', async () => {
    // The sink-level behavioural guarantee is asserted in the dedicated uow unit
    // test (tests/unit/engine/uow.observability.test.ts); here we only verify the
    // control header is accepted end-to-end.
    const sys = await bootOrders({ logger: createLogger({ level: 'info' }) });
    const persistent = await withPersistentServer(createGateway(sys));
    try {
      const res = await persistent.agent
        .post('/orders')
        .set('X-Potemkin-Log-Level', 'debug')
        .send({ sku: 'WIDGET-4' });
      expect(res.status).toBe(201);
    } finally {
      await persistent.close();
    }
  });
});
