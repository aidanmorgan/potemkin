/**
 * RED TEAM (surface 5): admin endpoints are unauthenticated by default.
 *
 * When ADMIN_TOKEN is unset (the documented default), /_admin/reset wipes ALL
 * state and /_admin/state dumps ALL state to any unauthenticated caller.
 * We confirm both, then confirm a set token closes them.
 */
import { bootSystem } from '../../src/engine/boot.js';
import { createGateway } from '../../src/http/gateway.js';
import { registerAdminRoutes } from '../../src/http/adminRoutes.js';
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
info: { title: Admin Auth Test, version: "1.0.0" }
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
components:
  schemas:
    Widget: { type: object, properties: { id: { type: string }, name: { type: string } } }
`;
const DSL = `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
identity: { creation: { generate: "$uuidv7()" } }
event_catalog:
  - type: WidgetCreated
    payload_template: { id: "command.targetId", name: "command.payload.name" }
behaviors:
  - { name: create-widget, match: { operationId: createWidget, condition: "true" }, emit: WidgetCreated }
reducers:
  - on: WidgetCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /name, value: "\${event.payload.name}" }
`;

async function bootApp() {
  const openapi = await loadOpenApi(OPENAPI);
  const sys = await bootSystem({ openapi, compiledDsl: await compileDsl([{ name: 'widget', yaml: DSL }]) });
  const app = createGateway(sys);
  registerAdminRoutes(app, sys);
  return app;
}

describe('admin endpoints unauthenticated by default', () => {
  const saved = process.env['ADMIN_TOKEN'];
  afterAll(() => { if (saved !== undefined) process.env['ADMIN_TOKEN'] = saved; });

  test('NO-TOKEN: unauthenticated caller can READ all state and WIPE the system', async () => {
    delete process.env['ADMIN_TOKEN'];
    const app = await bootApp();
    const { agent, close } = await withPersistentServer(app);
    registerFileTeardown(close);

    const id = nextUuidv7();
    await agent.post(`/widgets/${id}`).send({ name: 'secret-widget' });

    // (1) read all state with NO auth header
    const stateRes = await agent.get('/_admin/state');
    // eslint-disable-next-line no-console
    console.log('[NO-TOKEN] GET /_admin/state status=%d entities=%d',
      stateRes.status, Object.keys(stateRes.body.entities ?? {}).length);
    expect(stateRes.status).toBe(200);
    expect(Object.keys(stateRes.body.entities ?? {}).length).toBeGreaterThan(0);

    // (2) wipe all state with NO auth header
    const resetRes = await agent.post('/_admin/reset');
    // eslint-disable-next-line no-console
    console.log('[NO-TOKEN] POST /_admin/reset status=%d', resetRes.status);
    expect(resetRes.status).toBe(204);

    const afterReset = await agent.get('/_admin/state').expect(200);
    // eslint-disable-next-line no-console
    console.log('[NO-TOKEN] entities after reset =', Object.keys(afterReset.body.entities ?? {}).length);
    expect(Object.keys(afterReset.body.entities ?? {}).length).toBe(0);
  });

  test('WITH-TOKEN: setting ADMIN_TOKEN closes the endpoints (401 without bearer)', async () => {
    process.env['ADMIN_TOKEN'] = 'sekret';
    const app = await bootApp();
    const { agent, close } = await withPersistentServer(app);
    registerFileTeardown(close);

    const noAuth = await agent.get('/_admin/state');
    // eslint-disable-next-line no-console
    console.log('[WITH-TOKEN] no-bearer status=%d', noAuth.status);
    expect(noAuth.status).toBe(401);

    const withAuth = await agent.get('/_admin/state').set('Authorization', 'Bearer sekret');
    expect(withAuth.status).toBe(200);
  });
});
