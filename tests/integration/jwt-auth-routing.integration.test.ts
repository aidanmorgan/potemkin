/**
 * F1 integration: the engine gateway routes JWT validation through validateJwt
 * when auth.mode='jwt', and rejects the legacy `Bearer <id>:<scopes>` shortcut
 * with 401. Under auth.mode='simple' the legacy shortcut still works.
 */

import { bootSystem } from '../../src/engine/boot.js';
import { createGateway } from '../../src/http/gateway.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import { signJwtHs256 } from '../../src/identity/jwtValidator.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import {
  withPersistentServer,
  type PersistentAgent,
} from '../_support/persistentAgent.js';
import { registerFileTeardown } from '../_support/testTeardown.js';

const SECRET = 'integration-secret';

const OPENAPI = `
openapi: "3.0.3"
info: { title: JWT Routing Test, version: "1.0.0" }
paths:
  /widgets/{id}:
    post:
      operationId: createWidget
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Widget" }
      responses:
        "201":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Widget" }
components:
  schemas:
    Widget:
      type: object
      properties:
        id: { type: string }
        status: { type: string }
      required: [id, status]
`;

const WIDGET_DSL = `
boundary: Widget
contract_path: /widgets/{id}
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: WidgetCreated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: create-widget
    match:
      operationId: createWidget
      condition: "true"
    emit: WidgetCreated
reducers:
  - on: WidgetCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /status, value: "\${'NEW'}" }
`;

async function bootWith(globalYaml: string): Promise<PersistentAgent> {
  const openapi = await loadOpenApi(OPENAPI);
  const compiledDsl = await compileDsl([{ name: 'widget', yaml: WIDGET_DSL }], globalYaml);
  const sys = await bootSystem({ openapi, compiledDsl });
  const app = createGateway(sys);
  // One persistent server + pooled agent per booted app; closed in afterAll via
  // the file-scoped teardown registry.
  const { agent, close } = await withPersistentServer(app);
  registerFileTeardown(close);
  return agent;
}

const JWT_GLOBAL = `
auth:
  mode: jwt
  jwt:
    secret: ${SECRET}
`;

const SIMPLE_GLOBAL = `
auth:
  mode: simple
`;

describe('F1: JWT validation routing in the engine gateway', () => {
  const body = (id: string) => ({ id, status: 'NEW' });

  it('auth.mode=jwt + valid JWT → request proceeds (201)', async () => {
    const agent = await bootWith(JWT_GLOBAL);
    const id = nextUuidv7();
    const token = await signJwtHs256({ sub: 'alice', scopes: ['admin'] }, SECRET);
    const res = await agent
      .post(`/widgets/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body(id));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('NEW');
  });

  it('auth.mode=jwt + legacy "Bearer id:scopes" shortcut → 401 with WWW-Authenticate', async () => {
    const agent = await bootWith(JWT_GLOBAL);
    const id = nextUuidv7();
    const res = await agent
      .post(`/widgets/${id}`)
      .set('Authorization', 'Bearer mgr1:manager')
      .send(body(id));
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
  });

  it('auth.mode=jwt + invalid signature → 401', async () => {
    const agent = await bootWith(JWT_GLOBAL);
    const id = nextUuidv7();
    const forged = await signJwtHs256({ sub: 'mallory', scopes: ['admin'] }, 'wrong-secret');
    const res = await agent
      .post(`/widgets/${id}`)
      .set('Authorization', `Bearer ${forged}`)
      .send(body(id));
    expect(res.status).toBe(401);
  });

  it('auth.mode=simple + legacy "Bearer id:scopes" shortcut → still works (201)', async () => {
    const agent = await bootWith(SIMPLE_GLOBAL);
    const id = nextUuidv7();
    const res = await agent
      .post(`/widgets/${id}`)
      .set('Authorization', 'Bearer mgr1:manager')
      .send(body(id));
    expect(res.status).toBe(201);
  });
});
