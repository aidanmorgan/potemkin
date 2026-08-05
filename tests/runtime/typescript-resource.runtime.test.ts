import {
  eventType,
  operationId,
  resourceName,
  schemaReference,
} from '../../src/domain/references.js';
/** Pure TypeScript resource expansion e2e path. */

import { loadOpenApi } from '../../src/contract/loader.js';
import { bootRuntime } from '../../src/runtime/system.js';
import { createDefaultRuntimeHost } from '../../src/runtime/host.js';
import { createRuntimeGateway } from '../../src/http/runtimeGateway.js';
import { compileProgram } from '../../src/authoring/compiler.js';
import { defineSimulation, expression } from '../../src/authoring/builders.js';
import { reducerRule } from '../../src/authoring/nativeReducer.js';
import { defineResource } from '../../src/authoring/resourceModel.js';
import type { EventContext, IdentityContext } from '../../src/model/runtime.js';
import {
  withPersistentServer,
  type PersistentAgent,
  type PersistentServer,
} from '../_support/persistentAgent.js';

const OPENAPI = `
openapi: "3.0.3"
info: { title: TypeScript resource e2e, version: "1.0.0" }
paths:
  /invoices:
    post:
      operationId: createInvoice
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/InvoiceInput" }
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Invoice" }
  /invoices/{id}:
    get:
      operationId: getInvoice
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Invoice" }
components:
  schemas:
    InvoiceInput:
      type: object
      required: [amount]
      properties: { amount: { type: number } }
    Invoice:
      type: object
      required: [id, amount]
      properties: { id: { type: string }, amount: { type: number } }
`;

function definition(_openapi: Awaited<ReturnType<typeof loadOpenApi>>) {
  return defineSimulation({
    boundaries: [],
    resources: [
      defineResource({
        resource: resourceName('Invoice'),
        schema: schemaReference('Invoice'),
        identity: {
          generate: expression('identity', ({ helpers }: IdentityContext) => helpers.uuid()),
        },
        eventCatalog: [
          {
            type: eventType('InvoiceCreated'),
            payload: {
              id: expression('event', ({ command }: EventContext) => String(command.targetId)),
              amount: expression('event', ({ command }: EventContext) =>
                Number(command.payload['amount']),
              ),
            },
          },
        ],
        reducers: [
          reducerRule(eventType('InvoiceCreated'))
            .apply(({ state, event }) => ({
              ...state,
              id: String(event.payload['id']),
              amount: Number(event.payload['amount']),
            }))
            .build(),
        ],
        operations: [
          { operationId: operationId('createInvoice'), emit: eventType('InvoiceCreated') },
          { operationId: operationId('getInvoice'), query: true },
        ],
      }),
    ],
  });
}

describe('TypeScript-only resource authoring', () => {
  let server: PersistentServer;
  let agent: PersistentAgent;

  beforeAll(async () => {
    const openapi = await loadOpenApi(OPENAPI);
    const system = await bootRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      programFactory: ({ dependencies }) =>
        compileProgram(definition(openapi), { dependencies, openapi }),
    });
    server = await withPersistentServer(createRuntimeGateway(system));
    agent = server.agent;
  });

  afterAll(async () => server?.close());

  it('expands operation IDs into a working collection resource', async () => {
    const response = await agent.post('/invoices').send({ amount: 125.5 }).expect(201);
    expect(response.body.amount).toBe(125.5);
    expect(typeof response.body.id).toBe('string');
  });
});
