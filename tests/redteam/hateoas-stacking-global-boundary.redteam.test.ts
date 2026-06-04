/**
 * RED TEAM — combo 4 (stacking variant): GLOBAL hateoas × BOUNDARY hateoas × MASK
 * on ONE forwarded query response.
 *
 * Two distinct hateoas mechanisms can BOTH be active:
 *   - dsl.hateoas (global, enabled) → applied to the LIVE forward body
 *     (applyHateoasToQueryBody), producing _links.self.
 *   - boundary.hateoas (per-boundary) → emitted as a `{op: merge, path: /_links}`
 *     patch in _patches (NOT applied to the live body).
 *
 * Invariant: when both are active plus a DSL mask, the plugin (which applies
 * _patches to the returned body) must end up with a coherent body that carries
 * BOTH the global self link AND the boundary link merged into _links (no clobber),
 * and the masked field removed — exactly once each.
 */

import { bootSystem } from '../../src/engine/boot.js';
import { createGateway } from '../../src/http/gateway.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import { applyPatches, type Patch } from '../../src/dsl/patches.js';
import type { ForwardedRequest } from '../../src/forwarding/types.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import {
  withPersistentServer,
  type PersistentAgent,
} from '../_support/persistentAgent.js';
import { registerFileTeardown } from '../_support/testTeardown.js';

const OPENAPI = `
openapi: "3.0.3"
info: { title: Hateoas Stacking, version: "1.0.0" }
paths:
  /widgets/{id}:
    post: { operationId: createWidget, parameters: [{ name: id, in: path, required: true, schema: { type: string } }], requestBody: { required: true, content: { application/json: { schema: { $ref: "#/components/schemas/Widget" } } } }, responses: { "201": { content: { application/json: { schema: { $ref: "#/components/schemas/Widget" } } } } } }
    get: { operationId: getWidget, parameters: [{ name: id, in: path, required: true, schema: { type: string } }], responses: { "200": { content: { application/json: { schema: { $ref: "#/components/schemas/Widget" } } } } } }
components: { schemas: { Widget: { type: object, properties: { id: { type: string }, status: { type: string }, secret: { type: string } }, required: [id, status] } } }
`;

const DSL = `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: true
identity: { creation: { generate: "$uuidv7()" } }
hateoas: [{ rel: related, href: "/widgets/{id}/related" }]
mask: [secret]
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

// Global hateoas block — enabled, so the live forward body gets _links.self.
const GLOBAL = `
hateoas:
  enabled: true
`;

async function boot() {
  const openapi = await loadOpenApi(OPENAPI);
  const sys = await bootSystem({ openapi, compiledDsl: await compileDsl([{ name: 'widget', yaml: DSL }], GLOBAL) });
  return createGateway(sys);
}

describe('RED TEAM combo4-stacking: global + boundary hateoas + mask compose coherently', () => {
  let agent: PersistentAgent;

  beforeAll(async () => {
    const app = await boot();
    const persistent = await withPersistentServer(app);
    agent = persistent.agent;
    registerFileTeardown(persistent.close);
  });

  it('plugin-applied final body carries BOTH global self link AND boundary link, secret removed once', async () => {
    const id = nextUuidv7();
    await agent.post('/_engine/forward')
      .send({ method: 'POST', path: `/widgets/${id}`, headers: {}, query: {}, body: { id, status: 'NEW', secret: 'shhh' } })
      .expect(200);

    const res = await agent.post('/_engine/forward')
      .send({ method: 'GET', path: `/widgets/${id}`, headers: {}, query: {}, body: null })
      .expect(200);

    expect(res.body.status).toBe(200);
    const baseBody = res.body.body as Record<string, any>;
    const patches = (res.body._patches ?? []) as Patch[];

    // The live forward body already has the GLOBAL self link.
    expect(baseBody._links?.self?.href).toBe(`/widgets/${id}`);

    // Simulate the plugin: apply _patches (boundary hateoas merge + mask remove)
    // on top of the returned base body.
    const final = applyPatches(baseBody, patches, 'hateoas', { autoVivify: true }).newState as Record<string, any>;

    // INVARIANT: both links coexist (merge, not clobber) and secret is removed.
    expect(final._links?.self?.href).toBe(`/widgets/${id}`);   // global self preserved
    expect(final._links?.related?.href).toBe('/widgets/{id}/related'); // boundary link merged in
    expect(final.secret).toBeUndefined();                       // mask applied
    expect(final.status).toBe('NEW');                           // untouched field intact
  });
});
