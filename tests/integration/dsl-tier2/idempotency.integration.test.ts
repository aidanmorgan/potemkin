/**
 * REQ-81/82/83: Idempotency integration test
 *
 * Validates that:
 * - Second request with same Idempotency-Key returns cached response + X-Idempotency-Replay: true
 * - Same key with different body returns 409 IDEMPOTENCY_KEY_CONFLICT
 */
import { bootSystem } from '../../../src/engine/boot.js';
import { createGateway } from '../../../src/http/gateway.js';
import { loadOpenApi } from '../../../src/contract/loader.js';
import type { BootInput } from '../../../src/engine/boot.js';
import { compileDsl } from '../../../src/dsl/parser.js';
import {
  withPersistentServer,
  type PersistentAgent,
} from '../../_support/persistentAgent.js';
import { registerFileTeardown } from '../../_support/testTeardown.js';

const OPENAPI_YAML = `
openapi: '3.0.3'
info:
  title: Idempotency Test
  version: '1.0.0'
paths:
  /widgets:
    post:
      operationId: createWidget
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Widget'
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Widget'
components:
  schemas:
    Widget:
      type: object
      properties:
        id:
          type: string
        label:
          type: string
      additionalProperties: true
`;

const DSL_YAML = `
boundary: Widget
contract_path: /widgets
identity:
  creation:
    generate: '$uuidv7()'
behaviors:
  - name: createWidget
    match:
      operationId: createWidget
      condition: 'true'
    emit: WidgetCreated
event_catalog:
  - type: WidgetCreated
    payload_template:
      label: command.payload.label
reducers:
  - on: WidgetCreated
    patches:
      - { op: replace, path: /label, value: "\${event.payload.label}" }
`;

const GLOBAL_YAML = `
idempotency:
  enabled: true
  ttl_seconds: 86400
  hash_includes_body: true
`;

async function buildTestSystem(): Promise<ReturnType<typeof createGateway>> {
  const openapi = await loadOpenApi(OPENAPI_YAML);
  const dsl = await compileDsl([{ name: 'widget', yaml: DSL_YAML }], GLOBAL_YAML);
  const input: BootInput = { openapi, compiledDsl: await compileDsl([{ name: 'widget', yaml: DSL_YAML }]) };
  const sys = await bootSystem(input);
  // Patch the DSL with idempotency config so the gateway picks it up
  (sys as unknown as { dsl: typeof dsl }).dsl = dsl;
  return createGateway(sys);
}

describe('DSL Tier-2: Idempotency', () => {
  let agent: PersistentAgent;

  beforeAll(async () => {
    const app = await buildTestSystem();
    const persistent = await withPersistentServer(app);
    agent = persistent.agent;
    registerFileTeardown(persistent.close);
  });

  it('returns X-Idempotency-Replay: true on replay', async () => {
    const KEY = `test-key-${Date.now()}`;

    const first = await agent
      .post('/widgets')
      .set('Idempotency-Key', KEY)
      .send({ label: 'Widget Alpha' });
    expect(first.status).toBe(201);

    const second = await agent
      .post('/widgets')
      .set('Idempotency-Key', KEY)
      .send({ label: 'Widget Alpha' });
    expect(second.status).toBe(201);
    expect(second.headers['x-idempotency-replay']).toBe('true');
  });

  it('returns 409 IDEMPOTENCY_KEY_CONFLICT on same key, different body', async () => {
    const KEY = `conflict-key-${Date.now()}`;

    await agent
      .post('/widgets')
      .set('Idempotency-Key', KEY)
      .send({ label: 'Widget Alpha' });

    const conflict = await agent
      .post('/widgets')
      .set('Idempotency-Key', KEY)
      .send({ label: 'Widget Beta - DIFFERENT' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });
});
