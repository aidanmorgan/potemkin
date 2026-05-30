/**
 * D1/D2/D3 integration: the engine gateway injects HATEOAS _links, masks DSL
 * mask: fields, and emits Deprecation/Sunset headers on successful responses.
 */

import { bootSystem } from '../../src/engine/boot.js';
import { createGateway } from '../../src/http/gateway.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import {
  withPersistentServer,
  type PersistentAgent,
} from '../_support/persistentAgent.js';
import { registerFileTeardown } from '../_support/testTeardown.js';

const OPENAPI = `
openapi: "3.0.3"
info: { title: Response Mutations Test, version: "1.0.0" }
paths:
  /widgets/{id}:
    post:
      operationId: createWidget
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: "#/components/schemas/Widget" } } }
      responses:
        "201": { content: { application/json: { schema: { $ref: "#/components/schemas/Widget" } } } }
    get:
      operationId: getWidget
      deprecated: true
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses:
        "200": { content: { application/json: { schema: { $ref: "#/components/schemas/Widget" } } } }
components:
  schemas:
    Widget:
      type: object
      properties:
        id: { type: string }
        status: { type: string }
        secret: { type: string }
      required: [id, status]
`;

const DSL = `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
hateoas:
  - { rel: self, href: "/widgets/{id}" }
mask:
  - secret
deprecated:
  date: "2026-01-01"
  sunset: "2026-12-31"
  replacement: "/v2/widgets"
event_catalog:
  - type: WidgetCreated
    payload_template:
      id: "command.targetId"
      secret: "command.payload.secret"
behaviors:
  - name: create-widget
    match: { operationId: createWidget, condition: "true" }
    emit: WidgetCreated
  - name: get-widget
    match: { operationId: getWidget, condition: "true" }
    emit: WidgetCreated
reducers:
  - on: WidgetCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /status, value: "\${'NEW'}" }
      - { op: replace, path: /secret, value: "\${'shhh'}" }
`;

async function boot() {
  const openapi = await loadOpenApi(OPENAPI);
  const sys = await bootSystem({ openapi, compiledDsl: await compileDsl([{ name: 'widget', yaml: DSL }]) });
  return createGateway(sys);
}

async function createWidget(agent: PersistentAgent, id: string) {
  return agent.post(`/widgets/${id}`).send({ id, status: 'NEW', secret: 'shhh' });
}

describe('D1/D2/D3 response mutations via the gateway', () => {
  let agent: PersistentAgent;

  beforeAll(async () => {
    const app = await boot();
    const persistent = await withPersistentServer(app);
    agent = persistent.agent;
    registerFileTeardown(persistent.close);
  });

  it('D1: injects boundary HATEOAS _links into the response body', async () => {
    const id = nextUuidv7();
    await createWidget(agent, id);
    const res = await agent.get(`/widgets/${id}`).expect(200);
    expect(res.body._links?.self?.href).toBe('/widgets/{id}');
  });

  it('D3: removes the masked field from the response body', async () => {
    const id = nextUuidv7();
    await createWidget(agent, id);
    const res = await agent.get(`/widgets/${id}`).expect(200);
    expect(res.body.secret).toBeUndefined();
    expect(res.body.status).toBe('NEW');
  });

  it('D2: emits Deprecation + Sunset + successor Link headers', async () => {
    const id = nextUuidv7();
    await createWidget(agent, id);
    const res = await agent.get(`/widgets/${id}`).expect(200);
    expect(res.headers['deprecation']).toBe('true');
    expect(res.headers['sunset']).toBe('2026-12-31');
    expect(res.headers['link']).toContain('rel="successor-version"');
  });

  it('D3.3: the X-Potemkin-Mask control header REPLACES fields with [MASKED] (distinct from DSL mask removal)', async () => {
    const id = nextUuidv7();
    await createWidget(agent, id);
    // status is not in the DSL mask; the control header replaces it with [MASKED]
    // at runtime, while the DSL mask removes `secret` entirely.
    const res = await agent
      .get(`/widgets/${id}`)
      .set('X-Potemkin-Mask', 'status')
      .expect(200);
    expect(res.body.status).toBe('[MASKED]');
    expect(res.body.secret).toBeUndefined(); // DSL mask removes
  });
});
