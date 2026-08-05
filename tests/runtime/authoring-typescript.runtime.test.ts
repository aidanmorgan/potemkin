import {
  boundaryName,
  behaviorName,
  contractPath,
  eventType,
  operationId,
  pathSegment,
} from '../../src/domain/references.js';
/** Pure TypeScript authoring e2e path. */

import { createRuntimeGateway } from '../../src/http/runtimeGateway.js';
import { bootRuntime } from '../../src/runtime/system.js';
import { createDefaultRuntimeHost } from '../../src/runtime/host.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { boundary, event, expression, simulation } from '../../src/authoring/builders.js';
import { compileProgram } from '../../src/authoring/compiler.js';
import { reducerRule } from '../../src/authoring/nativeReducer.js';
import type {
  EventContext,
  IdentityContext,
  MatchContext,
  RuntimeReducerContext,
} from '../../src/model/runtime.js';
import {
  withPersistentServer,
  type PersistentAgent,
  type PersistentServer,
} from '../_support/persistentAgent.js';

const OPENAPI = `
openapi: "3.0.3"
info: { title: TypeScript authoring e2e, version: "1.0.0" }
paths:
  /things:
    post:
      operationId: createThing
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name]
              properties: { name: { type: string } }
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Thing" }
components:
  schemas:
    Thing:
      type: object
      required: [id, name]
      properties: { id: { type: string }, name: { type: string } }
`;

function definition() {
  return simulation()
    .boundary(
      boundary(boundaryName('Thing'), contractPath(pathSegment('things')))
        .identity({ generate: ({ helpers }: IdentityContext) => helpers.uuid() })
        .eventCatalog(
          event(eventType('ThingCreated'), {
            id: expression('event', ({ command }: EventContext) => command.targetId ?? ''),
            name: expression('event', ({ payload }: EventContext) =>
              String((payload as { name?: unknown }).name ?? ''),
            ),
          }),
        )
        .behavior({
          name: behaviorName('createThing'),
          operationId: operationId('createThing'),
          condition: expression('behavior', ({ payload }: MatchContext) => payload !== null),
          emit: eventType('ThingCreated'),
        })
        .reducer(
          reducerRule(eventType('ThingCreated'))
            .apply(({ state, event }: RuntimeReducerContext) => {
              const payload = event.payload as { id: string; name: string };
              return { ...state, id: payload.id, name: payload.name };
            })
            .build(),
        ),
    )
    .build();
}

describe('TypeScript-only authoring', () => {
  let server: PersistentServer;
  let agent: PersistentAgent;

  beforeAll(async () => {
    const openapi = await loadOpenApi(OPENAPI);
    const system = await bootRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      programFactory: ({ dependencies }) => compileProgram(definition(), { dependencies, openapi }),
    });
    server = await withPersistentServer(createRuntimeGateway(system));
    agent = server.agent;
  });

  afterAll(async () => server?.close());

  it('serves a request from a TypeScript-only simulation definition', async () => {
    const response = await agent.post('/things').send({ name: 'Ada' }).expect(201);
    expect(response.body.name).toBe('Ada');
    expect(typeof response.body.id).toBe('string');
  });
});
