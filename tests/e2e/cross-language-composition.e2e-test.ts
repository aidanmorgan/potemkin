import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { loadOpenApi } from '../../src/contract/loader.js';
import { createRuntimeGateway } from '../../src/http/runtimeGateway.js';
import { bootConfiguredRuntimeFromConfig } from '../../src/parser/configured.js';
import { createDefaultRuntimeHost } from '../../src/runtime/host.js';

describe('configured mixed composition end to end', () => {
  let root = '';

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'potemkin-cross-language-e2e-'));
    fs.mkdirSync(path.join(root, 'dsl'));
    fs.mkdirSync(path.join(root, 'scenarios'));
    fs.writeFileSync(
      path.join(root, 'potemkin.yml'),
      `version: 1
specmatic: ./specmatic.yaml
modules: ["dsl/*.yaml"]
openapi: ["openapi.yaml"]
typescript:
  scan:
    - include: ["scenarios/*.ts"]
`,
    );
    fs.writeFileSync(path.join(root, 'specmatic.yaml'), 'version: 3\n');
    fs.writeFileSync(
      path.join(root, 'openapi.yaml'),
      `openapi: "3.0.3"
info: { title: configured mixed composition, version: "1.0.0" }
paths:
  /orders:
    post:
      operationId: createOrder
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/OrderInput" }
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Order" }
components:
  schemas:
    OrderInput:
      type: object
      properties: { label: { type: string } }
    Order:
      type: object
      properties: { id: { type: string }, label: { type: string } }
`,
    );
    fs.writeFileSync(
      path.join(root, 'dsl', 'use.yaml'),
      `use:
  - { component: Order, as: Orders, contract_path: /orders }
`,
    );
    fs.writeFileSync(
      path.join(root, 'scenarios', 'order.ts'),
      `import {
  PotemkinConfigure,
  componentName,
  defineComponent,
  event,
  eventType,
  factoryName,
  operationId,
  reducerRule,
  simulation,
  behaviorName,
} from "potemkin/sdk";

const order = defineComponent(componentName("Order"), () => ({
  identity: { generate: ({ helpers }) => helpers.uuid() },
  eventCatalog: [event(eventType("OrderCreated"), { label: ({ command }) => command.payload.label })],
  behaviors: [{ name: behaviorName("create-order"), operationId: operationId("createOrder"), emit: eventType("OrderCreated") }],
  reducers: [reducerRule(eventType("OrderCreated")).apply(({ state, event: emitted }) => ({ ...state, label: emitted.payload.label })).build()],
}));

export class CrossLanguageFactory {
  @PotemkinConfigure(factoryName("cross-language"))
  static create() {
    return simulation().component(order).build();
  }
}
`,
    );
  });

  afterAll(() => {
    if (root !== '') fs.rmSync(root, { recursive: true, force: true });
  });

  it('boots YAML use -> TypeScript component and serves the contract route', async () => {
    const configPath = path.join(root, 'potemkin.yml');
    const openapi = await loadOpenApi(path.join(root, 'openapi.yaml'));
    const system = await bootConfiguredRuntimeFromConfig({
      host: createDefaultRuntimeHost(),
      potemkinConfigPath: configPath,
      openapi,
    });
    try {
      const response = await request(createRuntimeGateway(system))
        .post('/orders')
        .set('X-Potemkin-Seed', 'configured-cross-language')
        .send({ label: 'configured' });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ label: 'configured' });
    } finally {
      await system.dispose();
    }
  }, 60_000);
});
