/**
 * D4 integration: /_engine/forward returns a `_patches` envelope carrying the
 * response-mutation patches; re-applying them to the base body reproduces the
 * engine's mutated body, and deprecation headers are conveyed in `headers`.
 */

import request from 'supertest';
import { bootSystem } from '../../src/engine/boot.js';
import { createGateway } from '../../src/http/gateway.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import { applyPatches, type Patch } from '../../src/dsl/patches.js';
import type { ForwardedRequest } from '../../src/forwarding/types.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';

const OPENAPI = `
openapi: "3.0.3"
info: { title: Forward Patches Test, version: "1.0.0" }
paths:
  /widgets/{id}:
    post: { operationId: createWidget, parameters: [{ name: id, in: path, required: true, schema: { type: string } }], requestBody: { required: true, content: { application/json: { schema: { $ref: "#/components/schemas/Widget" } } } }, responses: { "201": { content: { application/json: { schema: { $ref: "#/components/schemas/Widget" } } } } } }
    get: { operationId: getWidget, deprecated: true, parameters: [{ name: id, in: path, required: true, schema: { type: string } }], responses: { "200": { content: { application/json: { schema: { $ref: "#/components/schemas/Widget" } } } } } }
components: { schemas: { Widget: { type: object, properties: { id: { type: string }, status: { type: string }, secret: { type: string } }, required: [id, status] } } }
`;

const DSL = `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: true
identity: { creation: { generate: "$uuidv7()" } }
hateoas: [{ rel: self, href: "/widgets/{id}" }]
mask: [secret]
deprecated: { date: "2026-01-01", sunset: "2026-12-31" }
event_catalog:
  - { type: WidgetCreated, payload_template: { id: "command.targetId", secret: "command.payload.secret" } }
behaviors:
  - { name: create-widget, match: { operationId: createWidget, condition: "true" }, emit: WidgetCreated }
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

describe('D4: /_engine/forward _patches envelope', () => {
  it('every successful forward carries a _patches array, and applying it reproduces the mutated body', async () => {
    const app = await boot();
    const id = nextUuidv7();
    const fwdCreate: ForwardedRequest = { method: 'POST', path: `/widgets/${id}`, headers: {}, query: {}, body: { id, status: 'NEW', secret: 'shhh' } };
    await request(app).post('/_engine/forward').send(fwdCreate).expect(200);

    const fwdGet: ForwardedRequest = { method: 'GET', path: `/widgets/${id}`, headers: {}, query: {}, body: null };
    const res = await request(app).post('/_engine/forward').send(fwdGet).expect(200);

    expect(res.body.status).toBe(200);
    // _patches present, carrying hateoas + mask
    expect(Array.isArray(res.body._patches)).toBe(true);
    const sources = (res.body._patches as Array<{ source: string }>).map((p) => p.source);
    expect(sources).toEqual(expect.arrayContaining(['hateoas', 'mask']));

    // Re-applying _patches to the returned base body reproduces the mutated body
    // (D4.3): _links added, secret removed.
    const patches = res.body._patches as Patch[];
    const reproduced = applyPatches(res.body.body, patches, 'hateoas', { autoVivify: true }).newState as any;
    expect(reproduced._links?.self?.href).toBe('/widgets/{id}');
    expect(reproduced.secret).toBeUndefined();

    // Deprecation headers are in the envelope headers, not _patches.
    expect(res.body.headers['deprecation']).toBe('true');
    expect(res.body.headers['sunset']).toBe('2026-12-31');
  });

  it('a forward with no response mutations omits _patches (or returns empty)', async () => {
    // GET a non-existent entity → 404; no mutations, no _patches.
    const app = await boot();
    const res = await request(app)
      .post('/_engine/forward')
      .send({ method: 'GET', path: `/widgets/${nextUuidv7()}`, headers: {}, query: {}, body: null })
      .expect(200);
    expect(res.body.status).toBe(404);
    expect(res.body._patches).toBeUndefined();
  });
});
