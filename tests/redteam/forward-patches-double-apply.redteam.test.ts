/**
 * RED TEAM — combo 4: MASK × HATEOAS × DEPRECATION stacking on the FORWARDING path.
 *
 * The /_engine/forward handler returns { body, headers, _patches }. The plugin's
 * response interceptor applies `_patches` to `body` to produce the final body
 * (proven by forward-patches-envelope.integration.test.ts, which re-applies the
 * patches to res.body.body).
 *
 * Invariant: `_patches` must describe deltas NOT already applied to the returned
 * `body` — otherwise applying them double-applies a mutation. Equivalently: the
 * returned `body` should be the un-mutated base for ALL sources in `_patches`,
 * OR all listed mutations should already be applied and `_patches` is purely
 * informational. The two must not be mixed.
 *
 * Suspected break: for a QUERY response the handler applies HATEOAS `_links` to
 * the LIVE body (handler.ts applyHateoasToQueryBody) but does NOT apply the DSL
 * `mask` removal to the live body. Yet BOTH a `hateoas` patch and a `mask` patch
 * are emitted in `_patches`. So the returned `body`:
 *   - ALREADY has `_links`  (hateoas applied live)   → re-applying _patches double-applies it
 *   - STILL has the masked field present (mask NOT applied live) → relies on plugin
 * This is an inconsistent contract: hateoas is pre-applied, mask is deferred,
 * both are in `_patches`.
 */

import { bootSystem } from '../../src/engine/boot.js';
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
info: { title: Forward Patches Double Apply, version: "1.0.0" }
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
hateoas: [{ rel: self, href: "/widgets/{id}" }]
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

async function boot() {
  const openapi = await loadOpenApi(OPENAPI);
  const sys = await bootSystem({ openapi, compiledDsl: await compileDsl([{ name: 'widget', yaml: DSL }]) });
  return createGateway(sys);
}

describe('RED TEAM combo4: _patches is internally consistent (no mixed pre-applied/deferred mutations)', () => {
  let agent: PersistentAgent;

  beforeAll(async () => {
    const app = await boot();
    const persistent = await withPersistentServer(app);
    agent = persistent.agent;
    registerFileTeardown(persistent.close);
  });

  it('query response body and _patches agree on what is applied (hateoas + mask both deferred OR both applied)', async () => {
    const id = nextUuidv7();
    const fwdCreate: ForwardedRequest = { method: 'POST', path: `/widgets/${id}`, headers: {}, query: {}, body: { id, status: 'NEW', secret: 'shhh' } };
    await agent.post('/_engine/forward').send(fwdCreate).expect(200);

    const fwdGet: ForwardedRequest = { method: 'GET', path: `/widgets/${id}`, headers: {}, query: {}, body: null };
    const res = await agent.post('/_engine/forward').send(fwdGet).expect(200);

    expect(res.body.status).toBe(200);
    const body = res.body.body as Record<string, unknown>;
    const patches = (res.body._patches ?? []) as Array<{ source: string }>;
    const sources = patches.map((p) => p.source);

    const hateoasInPatches = sources.includes('hateoas');
    const maskInPatches = sources.includes('mask');
    const linksAlreadyInBody = body['_links'] !== undefined;
    const secretAlreadyRemoved = body['secret'] === undefined;

    // Both boundary-level hateoas and mask are present as _patches deltas.
    expect(hateoasInPatches).toBe(true);
    expect(maskInPatches).toBe(true);

    // CONSISTENCY INVARIANT (HOLDS): _patches deltas are NOT pre-applied to the
    // returned base body — the plugin applies them exactly once. boundary-level
    // hateoas is deferred (NOT applied to the live forward body, unlike the
    // GLOBAL dsl.hateoas block), so there is no double-apply.
    expect(linksAlreadyInBody).toBe(false);   // _links not pre-applied
    expect(secretAlreadyRemoved).toBe(false); // secret not pre-removed — both deferred consistently
  });
});
