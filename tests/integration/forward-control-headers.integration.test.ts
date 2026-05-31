/**
 * /_engine/forward honours the X-Potemkin-* control-header tier, matching the
 * HTTP gateway:
 *
 *  - X-Potemkin-Response-Format: hal  → the forwarded body is re-shaped into the
 *    HAL representation (a `_links.self` is injected) and the response-format is
 *    echoed back in the forwarded headers.
 *  - X-Potemkin-Dry-Run: true         → the command executes for its response
 *    shape (success status) but NO events are appended to the store, so engine
 *    state is unchanged.
 *
 * Both assertions fail against a handler that does not parse control headers and
 * does not pass `controls` into executeUnitOfWork.
 */

import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { createGateway } from '../../src/http/gateway.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import type { ForwardedRequest } from '../../src/forwarding/types.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import {
  withPersistentServer,
  type PersistentAgent,
} from '../_support/persistentAgent.js';
import { registerFileTeardown } from '../_support/testTeardown.js';

const OPENAPI = `
openapi: "3.0.3"
info: { title: Forward Control Headers Test, version: "1.0.0" }
paths:
  /widgets/{id}:
    post: { operationId: createWidget, parameters: [{ name: id, in: path, required: true, schema: { type: string } }], requestBody: { required: true, content: { application/json: { schema: { $ref: "#/components/schemas/Widget" } } } }, responses: { "201": { content: { application/json: { schema: { $ref: "#/components/schemas/Widget" } } } } } }
    get: { operationId: getWidget, parameters: [{ name: id, in: path, required: true, schema: { type: string } }], responses: { "200": { content: { application/json: { schema: { $ref: "#/components/schemas/Widget" } } } } } }
components: { schemas: { Widget: { type: object, properties: { id: { type: string }, status: { type: string } }, required: [id, status] } } }
`;

const DSL = `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: true
identity: { creation: { generate: "$uuidv7()" } }
event_catalog:
  - { type: WidgetCreated, payload_template: { id: "command.targetId" } }
behaviors:
  - { name: create-widget, match: { operationId: createWidget, condition: "true" }, emit: WidgetCreated }
reducers:
  - on: WidgetCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /status, value: "\${'NEW'}" }
`;

async function boot(): Promise<{ sys: BootedSystem }> {
  const openapi = await loadOpenApi(OPENAPI);
  const sys = await bootSystem({ openapi, compiledDsl: await compileDsl([{ name: 'widget', yaml: DSL }]) });
  return { sys };
}

describe('/_engine/forward honours X-Potemkin control headers', () => {
  let agent: PersistentAgent;
  let sys: BootedSystem;

  beforeAll(async () => {
    const booted = await boot();
    sys = booted.sys;
    const app = createGateway(sys);
    const persistent = await withPersistentServer(app);
    agent = persistent.agent;
    registerFileTeardown(persistent.close);
  });

  it('X-Potemkin-Response-Format: hal reshapes the forwarded body into the HAL representation', async () => {
    const id = nextUuidv7();
    await agent
      .post('/_engine/forward')
      .send({ method: 'POST', path: `/widgets/${id}`, headers: {}, query: {}, body: { id, status: 'NEW' } } satisfies ForwardedRequest)
      .expect(200);

    const res = await agent
      .post('/_engine/forward')
      .send({
        method: 'GET',
        path: `/widgets/${id}`,
        headers: { 'X-Potemkin-Response-Format': 'hal' },
        query: {},
        body: null,
      } satisfies ForwardedRequest)
      .expect(200);

    expect(res.body.status).toBe(200);
    // HAL transform injected a self link and the format is echoed in headers.
    expect(res.body.body._links?.self?.href).toBe(`/widgets/${id}`);
    expect(res.body.headers['x-potemkin-response-format']).toBe('hal');
  });

  it('X-Potemkin-Dry-Run: true returns success but appends no events (state unchanged)', async () => {
    const id = nextUuidv7();
    const eventsBefore = sys.events.size();

    const res = await agent
      .post('/_engine/forward')
      .send({
        method: 'POST',
        path: `/widgets/${id}`,
        headers: { 'X-Potemkin-Dry-Run': 'true' },
        query: {},
        body: { id, status: 'NEW' },
      } satisfies ForwardedRequest)
      .expect(200);

    // Success status surfaced to the caller...
    expect(res.body.status).toBe(201);
    expect(res.body.headers['x-potemkin-dry-run']).toBe('true');

    // ...but the dry-run suppressed event persistence.
    expect(sys.events.size()).toBe(eventsBefore);
    expect(sys.events.byAggregate(id)).toHaveLength(0);
  });

  it('X-Potemkin-Read-At-Version=1 reconstructs the entity from its first event and echoes the version', async () => {
    const id = nextUuidv7();
    await agent
      .post('/_engine/forward')
      .send({ method: 'POST', path: `/widgets/${id}`, headers: {}, query: {}, body: { id, status: 'NEW' } } satisfies ForwardedRequest)
      .expect(200);

    const res = await agent
      .post('/_engine/forward')
      .send({
        method: 'GET',
        path: `/widgets/${id}`,
        headers: { 'X-Potemkin-Read-At-Version': '1' },
        query: {},
        body: null,
      } satisfies ForwardedRequest)
      .expect(200);

    expect(res.body.status).toBe(200);
    expect(res.body.headers['x-potemkin-read-at-version']).toBe('1');
    expect(res.body.body.id).toBe(id);
    expect(res.body.body.status).toBe('NEW');
  });

  it('X-Potemkin-Read-At-Version on an unknown entity returns 404 ENTITY_ABSENCE', async () => {
    const res = await agent
      .post('/_engine/forward')
      .send({
        method: 'GET',
        path: '/widgets/00000000-dead-7000-8000-000000000099',
        headers: { 'X-Potemkin-Read-At-Version': '3' },
        query: {},
        body: null,
      } satisfies ForwardedRequest)
      .expect(200);

    expect(res.body.status).toBe(404);
    expect(res.body.headers['x-potemkin-read-at-version']).toBe('3');
    expect(res.body.body.error).toBe('ENTITY_ABSENCE');
  });

  it('X-Potemkin-Replay-Event with an unknown id returns 404 EVENT_NOT_FOUND', async () => {
    const res = await agent
      .post('/_engine/forward')
      .send({
        method: 'GET',
        path: '/widgets/00000000-dead-7000-8000-000000000099',
        headers: { 'X-Potemkin-Replay-Event': 'evt-does-not-exist' },
        query: {},
        body: null,
      } satisfies ForwardedRequest)
      .expect(200);

    expect(res.body.status).toBe(404);
    expect(res.body.headers['x-potemkin-replayed-event']).toBe('evt-does-not-exist');
    expect(res.body.body.error).toBe('EVENT_NOT_FOUND');
  });

  it('X-Potemkin-Replay-Event resolves a real event by id', async () => {
    const id = nextUuidv7();
    await agent
      .post('/_engine/forward')
      .send({ method: 'POST', path: `/widgets/${id}`, headers: {}, query: {}, body: { id, status: 'NEW' } } satisfies ForwardedRequest)
      .expect(200);

    const eventId = sys.events.byAggregate(id)[0]!.eventId;

    const res = await agent
      .post('/_engine/forward')
      .send({
        method: 'GET',
        path: `/widgets/${id}`,
        headers: { 'X-Potemkin-Replay-Event': eventId },
        query: {},
        body: null,
      } satisfies ForwardedRequest)
      .expect(200);

    expect(res.body.status).toBe(200);
    expect(res.body.headers['x-potemkin-replayed-event']).toBe(eventId);
    expect(res.body.body.eventId).toBe(eventId);
    expect(res.body.body.aggregateId).toBe(id);
  });
});
