/**
 * Forwarding/gateway feature-parity integration tests for the adversarial-audit
 * fixes. Each block FAILS if its feature were gutted (parse-and-discard):
 *
 *  1. potemkin-933 — the /_engine/forward handler fires outbound webhooks via the
 *     injected transport (and X-Potemkin-Skip-Webhooks suppresses them), matching
 *     the gateway. A handler that omits webhookTransport never delivers.
 *
 *  2. potemkin-mev — X-Potemkin-Skip-Response-Validation and
 *     X-Potemkin-Allow-Additional-Properties reach the validator: a response that
 *     violates strict (additionalProperties:false) validation fails without the
 *     header (500) and passes with it.
 *
 *  3. potemkin-wam — X-Specmatic-Result: success is set on 2xx responses and
 *     failure on error responses, on BOTH the gateway and forwarding paths.
 */

import { bootSystem, type BootedSystem, type BootInput } from '../../src/engine/boot.js';
import { createGateway } from '../../src/http/gateway.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import type { ForwardedRequest } from '../../src/forwarding/types.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import type { FetchLike } from '../../src/webhooks/dispatcher.js';
import { WEBHOOK_SIGNATURE_HEADER } from '../../src/webhooks/dispatcher.js';
import {
  withPersistentServer,
  type PersistentAgent,
  type PersistentServer,
} from '../_support/persistentAgent.js';

const WEBHOOK_SECRET = 'forward-parity-secret';

// Two schemas deliberately diverge:
//  - `Widget` (the boundary/state schema used by the static DSL checker + the
//    object-graph registry) is permissive and DECLARES `surprise`, so the reducer
//    may legally write it and the static check passes.
//  - `WidgetResponse` (the 201 response content schema used by validateResponse)
//    is strict (additionalProperties:false) and does NOT declare `surprise`, so a
//    response carrying `surprise` fails strict response validation.
// This lets the skip / allow-additional controls be observed without tripping the
// boot-time static checker.
const OPENAPI = `
openapi: "3.0.3"
info: { title: Forward Feature Parity, version: "1.0.0" }
paths:
  /widgets/{id}:
    post:
      operationId: createWidget
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: "#/components/schemas/WidgetIn" } } }
      responses:
        "201": { description: created, content: { application/json: { schema: { $ref: "#/components/schemas/WidgetResponse" } } } }
    get:
      operationId: getWidget
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses:
        "200": { description: ok, content: { application/json: { schema: { $ref: "#/components/schemas/WidgetResponse" } } } }
        "404": { description: missing }
components:
  schemas:
    WidgetIn:
      type: object
      additionalProperties: true
      properties:
        id: { type: string }
        rogue: { type: boolean }
    Widget:
      type: object
      additionalProperties: false
      required: [id, status]
      properties:
        id: { type: string }
        status: { type: string }
        surprise: { type: string }
    WidgetResponse:
      type: object
      additionalProperties: false
      required: [id, status]
      properties:
        id: { type: string }
        status: { type: string }
`;

// On creation the reducer always sets id + status. When the request payload sets
// `rogue: true`, a second reducer writes the `surprise` field — declared on the
// permissive boundary schema (so the static check passes) but absent from the
// strict WidgetResponse schema (so strict response validation rejects it).
const DSL = `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: true
identity: { creation: { generate: "$uuidv7()" } }
event_catalog:
  - type: WidgetCreated
    payload_template: { id: "command.targetId" }
  - type: WidgetTainted
    payload_template: { id: "command.targetId" }
behaviors:
  # First-match resolution fires ONE behavior; emit_when then conditionally emits
  # BOTH the base creation event (always) and the taint event (only when the
  # request asks for it), so a single createWidget command can produce both.
  - name: create-widget
    match: { operationId: createWidget, condition: "true" }
    emit_when:
      - { when: "true", emit: WidgetCreated }
      # Taints the entity with an undeclared (per WidgetResponse) surprise field,
      # making the response fail strict validation.
      - { when: "has(command.payload.rogue) && command.payload.rogue == true", emit: WidgetTainted }
reducers:
  - on: WidgetCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /status, value: "\${'NEW'}" }
  - on: WidgetTainted
    patches:
      - { op: add, path: /surprise, value: "\${'boom'}" }
`;

const GLOBAL_YAML = `
webhooks:
  - name: widget-created-webhook
    trigger:
      boundary: Widget
      intent: creation
      condition: "true"
    url: "'http://127.0.0.1:1/widget-hook'"
    secret: "${WEBHOOK_SECRET}"
    payload:
      widgetId: "\${event.aggregateId}"
    retry:
      maxAttempts: 1
`;

interface RecordedDelivery {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

function makeRecordingTransport(): { transport: FetchLike; deliveries: RecordedDelivery[] } {
  const deliveries: RecordedDelivery[] = [];
  const transport: FetchLike = async (url, init) => {
    deliveries.push({ url, headers: init.headers, body: init.body });
    return { ok: true, status: 200 };
  };
  return { transport, deliveries };
}

/** Drain fire-and-forget microtasks so deferred deliveries settle before asserting. */
async function drain(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

async function boot(extra: Partial<BootInput>): Promise<BootedSystem> {
  const openapi = await loadOpenApi(OPENAPI);
  const compiledDsl = await compileDsl([{ name: 'widget', yaml: DSL }], GLOBAL_YAML);
  return bootSystem({ openapi, compiledDsl, ...extra });
}

describe('forwarding/gateway feature parity (adversarial audit)', () => {
  let sys: BootedSystem;
  let persistent: PersistentServer;
  let agent: PersistentAgent;
  let deliveries: RecordedDelivery[];

  beforeAll(async () => {
    const rec = makeRecordingTransport();
    deliveries = rec.deliveries;
    sys = await boot({ webhookTransport: rec.transport });
    persistent = await withPersistentServer(createGateway(sys));
    agent = persistent.agent;
  });

  afterAll(async () => {
    await persistent.close();
  });

  beforeEach(() => {
    deliveries.length = 0;
  });

  // --- Item 1: potemkin-933 — forwarding handler fires webhooks ---------------

  describe('potemkin-933: /_engine/forward fires outbound webhooks', () => {
    it('a forwarded creation whose boundary declares a webhook invokes the injected transport', async () => {
      const id = nextUuidv7();
      const res = await agent
        .post('/_engine/forward')
        .send({ method: 'POST', path: `/widgets/${id}`, headers: {}, query: {}, body: { id } } satisfies ForwardedRequest)
        .expect(200);
      expect(res.body.status).toBe(201);
      await drain();

      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.url).toBe('http://127.0.0.1:1/widget-hook');
      // Signed with HMAC-SHA256 over the templated body.
      const { createHmac } = await import('node:crypto');
      const expected = createHmac('sha256', WEBHOOK_SECRET).update(deliveries[0]!.body).digest('hex');
      expect(deliveries[0]!.headers[WEBHOOK_SIGNATURE_HEADER]).toBe(expected);
      const payload = JSON.parse(deliveries[0]!.body) as { widgetId: string };
      expect(payload.widgetId).toBe(id);
    });

    it('X-Potemkin-Skip-Webhooks: true suppresses delivery on the forwarding path', async () => {
      const id = nextUuidv7();
      await agent
        .post('/_engine/forward')
        .send({
          method: 'POST',
          path: `/widgets/${id}`,
          headers: { 'X-Potemkin-Skip-Webhooks': 'true' },
          query: {},
          body: { id },
        } satisfies ForwardedRequest)
        .expect(200);
      await drain();
      expect(deliveries).toHaveLength(0);
    });
  });

  // --- Item 2: potemkin-mev — validation controls reach the validator ---------

  describe('potemkin-mev: response-validation controls reach the validator', () => {
    it('an undeclared response field fails strict validation by default (500)', async () => {
      const id = nextUuidv7();
      const res = await agent
        .post('/_engine/forward')
        .send({ method: 'POST', path: `/widgets/${id}`, headers: {}, query: {}, body: { id, rogue: true } } satisfies ForwardedRequest)
        .expect(200);
      // The reducer wrote `surprise`, which additionalProperties:false rejects.
      expect(res.body.status).toBe(500);
    });

    it('X-Potemkin-Skip-Response-Validation: true lets the same response through (2xx)', async () => {
      const id = nextUuidv7();
      const res = await agent
        .post('/_engine/forward')
        .send({
          method: 'POST',
          path: `/widgets/${id}`,
          headers: {
            'X-Potemkin-Skip-Response-Validation': 'true',
            Authorization: 'Bearer admin',
          },
          query: {},
          body: { id, rogue: true },
        } satisfies ForwardedRequest)
        .expect(200);
      expect(res.body.status).toBe(201);
      expect(res.body.body.surprise).toBe('boom');
    });

    it('X-Potemkin-Allow-Additional-Properties: true relaxes the strict schema (2xx)', async () => {
      const id = nextUuidv7();
      const res = await agent
        .post('/_engine/forward')
        .send({
          method: 'POST',
          path: `/widgets/${id}`,
          headers: {
            'X-Potemkin-Allow-Additional-Properties': 'true',
            Authorization: 'Bearer admin',
          },
          query: {},
          body: { id, rogue: true },
        } satisfies ForwardedRequest)
        .expect(200);
      expect(res.body.status).toBe(201);
      // The undeclared property survived because additionalProperties was relaxed.
      expect(res.body.body.surprise).toBe('boom');
    });
  });

  // --- Item 3: potemkin-wam — X-Specmatic-Result on both paths ----------------

  describe('potemkin-wam: X-Specmatic-Result is set on success and failure', () => {
    it('gateway tags success on a 2xx response', async () => {
      const id = nextUuidv7();
      const res = await agent.post(`/widgets/${id}`).send({ id }).expect(201);
      expect(res.headers['x-specmatic-result']).toBe('success');
    });

    it('gateway tags failure on an error response', async () => {
      // GET an unknown widget → 404 ENTITY_ABSENCE from the UoW error path.
      const res = await agent.get(`/widgets/${nextUuidv7()}`).expect(404);
      expect(res.headers['x-specmatic-result']).toBe('failure');
    });

    it('forwarding tags success on a 2xx response', async () => {
      const id = nextUuidv7();
      const res = await agent
        .post('/_engine/forward')
        .send({ method: 'POST', path: `/widgets/${id}`, headers: { 'X-Potemkin-Skip-Webhooks': 'true' }, query: {}, body: { id } } satisfies ForwardedRequest)
        .expect(200);
      expect(res.body.status).toBe(201);
      expect(res.body.headers['x-specmatic-result']).toBe('success');
    });

    it('forwarding tags failure on an error response', async () => {
      const res = await agent
        .post('/_engine/forward')
        .send({ method: 'GET', path: `/widgets/${nextUuidv7()}`, headers: {}, query: {}, body: null } satisfies ForwardedRequest)
        .expect(200);
      expect(res.body.status).toBe(404);
      expect(res.body.headers['x-specmatic-result']).toBe('failure');
    });
  });
});
