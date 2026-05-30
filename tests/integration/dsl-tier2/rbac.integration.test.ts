/**
 * REQ-84/85/86: RBAC scopes integration test
 *
 * Validates that behaviors with required_scopes:
 *  - Allow requests with sufficient scopes
 *  - Return 401 when no actor present
 *  - Return 403 when actor lacks required scopes
 */
import supertest from 'supertest';
import { bootSystem } from '../../../src/engine/boot.js';
import { createGateway } from '../../../src/http/gateway.js';
import { loadOpenApi } from '../../../src/contract/loader.js';
import { compileDsl } from '../../../src/dsl/parser.js';
import type { BootInput } from '../../../src/engine/boot.js';

// Minimal OpenAPI for this test
const OPENAPI_YAML = `
openapi: '3.0.3'
info:
  title: RBAC Test
  version: '1.0.0'
paths:
  /items:
    post:
      operationId: createItem
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Item'
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Item'
components:
  schemas:
    Item:
      type: object
      properties:
        id:
          type: string
        name:
          type: string
      additionalProperties: true
`;

const DSL_YAML = `
boundary: Item
contract_path: /items
identity:
  creation:
    generate: '$uuidv7()'
behaviors:
  - name: createSecureItem
    match:
      operationId: createItem
      condition: 'true'
      required_scopes: [admin]
    emit: ItemCreated
event_catalog:
  - type: ItemCreated
    payload_template:
      name: command.payload.name
reducers:
  - on: ItemCreated
    patches:
      - { op: replace, path: /name, value: event.payload.name }
`;

async function buildTestSystem(): Promise<{ app: ReturnType<typeof createGateway>; sys: Awaited<ReturnType<typeof bootSystem>> }> {
  const openapi = await loadOpenApi(OPENAPI_YAML);
  const input: BootInput = {
    openapi,
    compiledDsl: await compileDsl([{ name: 'item', yaml: DSL_YAML }]),
  };
  const sys = await bootSystem(input);
  const app = createGateway(sys);
  return { app, sys };
}

describe('DSL Tier-2: RBAC scopes', () => {
  it('allows request with required scope (admin)', async () => {
    const { app } = await buildTestSystem();
    const res = await supertest(app)
      .post('/items')
      .set('Authorization', 'Bearer alice:admin,trader')
      .send({ name: 'SecureItem' });
    expect(res.status).toBe(201);
  });

  it('returns 401 when no Authorization header and scope required', async () => {
    const { app } = await buildTestSystem();
    const res = await supertest(app)
      .post('/items')
      .send({ name: 'SecureItem' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_MISSING');
  });

  it('returns 403 when actor lacks required scope', async () => {
    const { app } = await buildTestSystem();
    const res = await supertest(app)
      .post('/items')
      .set('Authorization', 'Bearer bob:viewer')
      .send({ name: 'SecureItem' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AUTH_INSUFFICIENT_SCOPES');
  });
});
