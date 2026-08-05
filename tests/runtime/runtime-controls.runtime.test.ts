import {
  boundaryName,
  behaviorName,
  contractPath,
  eventType,
  faultName,
  operationId,
  pathParameter,
  pathSegment,
} from '../../src/domain/references.js';
import request from 'supertest';
import { loadOpenApi } from '../../src/contract/loader.js';
import { bootRuntime, type RuntimeSystem } from '../../src/runtime/system.js';
import { createDefaultRuntimeHost } from '../../src/runtime/host.js';
import { bootYamlRuntime } from '../../src/parser/runtime.js';
import { createRuntimeGateway } from '../../src/http/runtimeGateway.js';
import { boundary, behavior, event, simulation } from '../../src/authoring/builders.js';
import { compileProgram } from '../../src/authoring/compiler.js';
import { reducerRule } from '../../src/authoring/nativeReducer.js';
import type { EventContext, FaultContext, IdentityContext } from '../../src/model/runtime.js';

const OPENAPI = `
openapi: "3.0.3"
info: { title: Runtime controls, version: "1.0.0" }
paths:
  /resources:
    post:
      operationId: createResource
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/ResourceInput" }
      responses:
        "201":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Resource" }
  /resources/{id}:
    get:
      operationId: getResource
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses:
        "200":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Resource" }
    patch:
      operationId: updateResource
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/ResourceInput" }
      responses:
        "200":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Resource" }
components:
  schemas:
    ResourceInput:
      type: object
      required: [id, value]
      additionalProperties: false
      properties:
        id: { type: string }
        value: { type: string }
    Resource:
      type: object
      required: [id, value, at, generated]
      additionalProperties: false
      properties:
        id: { type: string }
        value: { type: string }
        at: { type: string }
        generated: { type: string }
`;

const YAML_BOUNDARIES = `
boundary: Resource
contract_path: /resources
identity:
  creation:
    generate: command.payload.id
event_catalog:
  - type: ResourceCreated
    payload_template:
      id: command.payload.id
      value: command.payload.value
      at: $now()
      generated: $uuidv7()
behaviors:
  - name: create-resource
    match: { operationId: createResource, condition: "true" }
    emit: ResourceCreated
reducers:
  - on: ResourceCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /value, value: "\${event.payload.value}" }
      - { op: replace, path: /at, value: "\${event.payload.at}" }
      - { op: replace, path: /generated, value: "\${event.payload.generated}" }
latency: { fixed_ms: 7 }
`;

const YAML_BY_ID = `
boundary: ResourceById
contract_path: /resources/{id}
fallback_override: true
identity:
  key: { from: path, name: id }
event_catalog:
  - type: ResourceUpdated
    payload_template:
      value: command.payload.value
      at: $now()
      generated: $uuidv7()
behaviors:
  - name: update-resource
    match: { operationId: updateResource, condition: "true" }
    emit: ResourceUpdated
reducers:
  - on: ResourceUpdated
    patches:
      - { op: replace, path: /value, value: "\${event.payload.value}" }
      - { op: replace, path: /at, value: "\${event.payload.at}" }
      - { op: replace, path: /generated, value: "\${event.payload.generated}" }
`;

const YAML_GLOBAL = `
fault_rules:
  - name: maintenance
    match:
      headers: { x-potemkin-force-response: maintenance }
      condition: "true"
    response:
      status: 503
      body: { code: MAINTENANCE }
  - name: slow-scenario
    match:
      headers: { x-potemkin-scenario: slow }
      condition: "true"
    response:
      status: 429
      body: { code: SLOW_SCENARIO }
  - name: beta-response
    match:
      headers: { x-potemkin-feature-flag: beta }
      condition: "true"
    response:
      status: 418
      body: { code: BETA_RESPONSE }
`;

function directDefinition() {
  const created = event(eventType('ResourceCreated'), {
    id: ({ command }: EventContext) => command.payload.id,
    value: ({ command }: EventContext) => command.payload.value,
    at: ({ helpers }: EventContext) => helpers.now(),
    generated: ({ helpers }: EventContext) => helpers.uuid(),
  });
  const updated = event(eventType('ResourceUpdated'), {
    value: ({ command }: EventContext) => command.payload.value,
    at: ({ helpers }: EventContext) => helpers.now(),
    generated: ({ helpers }: EventContext) => helpers.uuid(),
  });
  const maintenance = {
    name: faultName('maintenance'),
    selectors: { forceResponse: 'maintenance' },
    matches: ({ headers }: FaultContext) => headers['x-potemkin-force-response'] === 'maintenance',
    response: { status: 503, body: { code: 'MAINTENANCE' } },
  } as const;
  const slowScenario = {
    name: faultName('slow-scenario'),
    selectors: { scenario: 'slow' },
    matches: () => true,
    response: { status: 429, body: { code: 'SLOW_SCENARIO' } },
  } as const;
  const betaResponse = {
    name: faultName('beta-response'),
    selectors: { featureFlag: 'beta' },
    matches: () => true,
    response: { status: 418, body: { code: 'BETA_RESPONSE' } },
  } as const;
  const createdReducer = reducerRule(eventType('ResourceCreated'))
    .apply(({ state, event: emitted }) => ({
      ...state,
      id: emitted.payload.id,
      value: emitted.payload.value,
      at: emitted.payload.at,
      generated: emitted.payload.generated,
    }))
    .build();
  const updatedReducer = reducerRule(eventType('ResourceUpdated'))
    .apply(({ state, event: emitted }) => ({
      ...state,
      value: emitted.payload.value,
      at: emitted.payload.at,
      generated: emitted.payload.generated,
    }))
    .build();
  return simulation()
    .boundary(
      boundary(boundaryName('Resource'), contractPath(pathSegment('resources')))
        .identity({ generate: ({ payload }: IdentityContext) => String(payload.id) })
        .eventCatalog(created)
        .behavior(
          behavior({
            name: behaviorName('create-resource'),
            operationId: operationId('createResource'),
            emit: eventType('ResourceCreated'),
          }),
        )
        .reducer(createdReducer)
        .latency({ fixedMs: 7 })
        .build(),
    )
    .boundary(
      boundary(
        boundaryName('ResourceById'),
        contractPath(pathSegment('resources'), pathParameter('id')),
      )
        .fallbackOverride(true)
        .identity({ key: { from: 'path', name: 'id' } })
        .eventCatalog(updated)
        .behavior(
          behavior({
            name: behaviorName('update-resource'),
            operationId: operationId('updateResource'),
            emit: eventType('ResourceUpdated'),
          }),
        )
        .reducer(updatedReducer)
        .build(),
    )
    .global({ faults: [maintenance, slowScenario, betaResponse] })
    .build();
}

async function bootPair(): Promise<[RuntimeSystem, RuntimeSystem, number[][]]> {
  const openapi = await loadOpenApi(OPENAPI);
  const sleeps: number[][] = [[], []];
  const helpers = {
    now: () => '2026-01-01T00:00:00.000Z',
    uuid: () => '00000000-0000-7000-8000-000000000001',
    random: () => 0,
    data: (await import('../../src/model/data.js')).createRuntimeDataGenerator(() => 0),
    clone: <T>(value: T) => structuredClone(value),
  };
  const [yamlSystem, typescriptSystem] = await Promise.all([
    bootYamlRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      yamlProgram: {
        modules: [
          { name: 'resources.yaml', yaml: YAML_BOUNDARIES },
          { name: 'resource-by-id.yaml', yaml: YAML_BY_ID },
        ],
        globalYaml: YAML_GLOBAL,
      },
      helpers,
      sleep: async (milliseconds) => {
        sleeps[0]!.push(milliseconds);
      },
    }),
    bootRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      programFactory: ({ dependencies }) =>
        compileProgram(directDefinition(), { dependencies, openapi }),
      helpers,
      sleep: async (milliseconds) => {
        sleeps[1]!.push(milliseconds);
      },
    }),
  ]);
  return [yamlSystem, typescriptSystem, sleeps];
}

describe('source-independent runtime control behaviour', () => {
  let systems: [RuntimeSystem, RuntimeSystem, number[][]];

  beforeEach(async () => {
    systems = await bootPair();
  });
  afterEach(async () => {
    await Promise.all([systems[0].dispose(), systems[1].dispose()]);
  });

  it.each([
    ['YAML', 0],
    ['TypeScript', 1],
  ] as const)(
    '%s applies request-local clock offsets and deterministic seeds',
    async (_name, index) => {
      const app = createRuntimeGateway(systems[index]);
      const response = await request(app)
        .post('/resources')
        .set('X-Potemkin-Clock-Offset', '3600000')
        .set('X-Potemkin-Seed', 'same-seed')
        .send({ id: `${_name.toLowerCase()}-seeded`, value: 'created' })
        .expect(201);
      expect(response.body.at).toBe('2026-01-01T01:00:00.000Z');
      expect(response.body.generated).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );

      const ordinary = await request(app)
        .post('/resources')
        .send({ id: `${_name.toLowerCase()}-ordinary`, value: 'ordinary' })
        .expect(201);
      expect(ordinary.body.at).toBe('2026-01-01T00:00:00.000Z');
    },
  );

  it.each([
    ['YAML', 0],
    ['TypeScript', 1],
  ] as const)(
    '%s isolates request-local clock and seed controls across concurrent requests',
    async (_name, index) => {
      const app = createRuntimeGateway(systems[index]);
      const [ahead, behind] = await Promise.all([
        request(app)
          .post('/resources')
          .set('X-Potemkin-Clock-Offset', '3600000')
          .set('X-Potemkin-Seed', `${_name}-ahead`)
          .send({ id: `${_name.toLowerCase()}-concurrent-ahead`, value: 'ahead' }),
        request(app)
          .post('/resources')
          .set('X-Potemkin-Clock-Offset', '-3600000')
          .set('X-Potemkin-Seed', `${_name}-behind`)
          .send({ id: `${_name.toLowerCase()}-concurrent-behind`, value: 'behind' }),
      ]);

      expect(ahead.status).toBe(201);
      expect(behind.status).toBe(201);
      expect(ahead.body.at).toBe('2026-01-01T01:00:00.000Z');
      expect(behind.body.at).toBe('2025-12-31T23:00:00.000Z');
      expect(ahead.body.generated).not.toBe(behind.body.generated);

      const ordinary = await request(app)
        .post('/resources')
        .send({ id: `${_name.toLowerCase()}-concurrent-ordinary`, value: 'ordinary' })
        .expect(201);
      expect(ordinary.body.at).toBe('2026-01-01T00:00:00.000Z');
    },
  );

  it.each([
    ['YAML', 0],
    ['TypeScript', 1],
  ] as const)(
    '%s reads history through a separate resource-by-id boundary and replays events',
    async (_name, index) => {
      const app = createRuntimeGateway(systems[index]);
      const created = await request(app)
        .post('/resources')
        .send({ id: `${_name.toLowerCase()}-history`, value: 'created' })
        .expect(201);
      await request(app)
        .patch(`/resources/${_name.toLowerCase()}-history`)
        .send({ id: `${_name.toLowerCase()}-history`, value: 'updated' })
        .expect(200);

      const historical = await request(app)
        .get(`/resources/${_name.toLowerCase()}-history`)
        .set('X-Potemkin-Read-At-Version', '1')
        .expect(200);
      expect(historical.body.value).toBe('created');
      expect(historical.headers.etag).toBe('"1"');

      const before = systems[index].engine.snapshot().events.length;
      const replay = await request(app)
        .get(`/resources/${_name.toLowerCase()}-history`)
        .set(
          'X-Potemkin-Replay-Event',
          created.body._events?.[0]?.eventId ??
            systems[index].engine
              .snapshot()
              .events.find((event) => event.type === 'ResourceCreated')!.eventId,
        );
      expect(replay.status).toBe(200);
      expect(replay.headers['x-potemkin-replayed-event']).toBeDefined();
      expect(systems[index].engine.snapshot().events.length).toBe(before + 1);
    },
  );

  it.each([
    ['YAML', 0],
    ['TypeScript', 1],
  ] as const)('%s preserves chaos precedence and prevents mutation', async (_name, index) => {
    const app = createRuntimeGateway(systems[index]);
    await request(app)
      .post('/resources')
      .set('X-Potemkin-Force-Response', 'maintenance')
      .send({ id: `${_name.toLowerCase()}-fault`, value: 'blocked' })
      .expect(503, { code: 'MAINTENANCE' });
    await request(app)
      .post('/resources')
      .set('X-Potemkin-Scenario', 'slow')
      .send({ id: `${_name.toLowerCase()}-scenario`, value: 'blocked' })
      .expect(429, { code: 'SLOW_SCENARIO' });
    await request(app)
      .post('/resources')
      .set('X-Potemkin-Feature-Flag', 'beta')
      .send({ id: `${_name.toLowerCase()}-feature`, value: 'blocked' })
      .expect(418, { code: 'BETA_RESPONSE' });
    expect(systems[index].engine.snapshot().events).toHaveLength(0);

    const forced = await request(app)
      .get(`/resources/${_name.toLowerCase()}-missing`)
      .set('X-Potemkin-Force-Status', '418')
      .set('X-Potemkin-Retry-After', '4')
      .set('X-Potemkin-Body-Truncate', '10')
      .buffer(true)
      .parse((response, callback) => {
        let data = '';
        response.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        response.on('end', () => callback(null, data));
      })
      .expect(418);
    expect(forced.headers['retry-after']).toBe('4');
    expect(String(forced.body).length).toBeLessThanOrEqual(10);
  });

  it.each([
    ['YAML', 0],
    ['TypeScript', 1],
  ] as const)(
    '%s stacks boundary latency and exposes synthetic forwarding drops',
    async (_name, index) => {
      const app = createRuntimeGateway(systems[index]);
      await request(app)
        .post('/resources')
        .send({ id: `${_name.toLowerCase()}-latency`, value: 'created' })
        .expect(201);
      expect(systems[2][index]).toContain(7);

      const before = systems[index].engine.snapshot().events.length;
      const forwarded = await request(app)
        .post('/_engine/forward')
        .send({
          method: 'GET',
          path: `/resources/${_name.toLowerCase()}-latency`,
          headers: { 'x-potemkin-drop-connection': '0' },
          query: {},
          body: null,
        })
        .expect(200);
      expect(forwarded.body).toMatchObject({
        status: 504,
        body: null,
        headers: { 'x-potemkin-dropped': 'true' },
      });
      expect(systems[index].engine.snapshot().events.length).toBe(before);
    },
  );

  it.each([
    ['YAML', 0],
    ['TypeScript', 1],
  ] as const)('%s truncates UTF-8 responses at a valid byte boundary', async (_name, index) => {
    const response = await request(createRuntimeGateway(systems[index]))
      .post('/resources')
      .set('X-Potemkin-Body-Truncate', '24')
      .send({ id: `${_name.toLowerCase()}-é`, value: 'éclair' })
      .buffer(true)
      .parse((incoming, callback) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    const body = Buffer.isBuffer(response.body)
      ? response.body
      : Buffer.from(String(response.body));
    expect(body.byteLength).toBeLessThanOrEqual(24);
    expect(body.toString('utf8')).not.toContain('�');
  });

  it.each([
    ['YAML', 0],
    ['TypeScript', 1],
  ] as const)(
    '%s expires dynamic typed faults under the administrative clock and reset clears them',
    async (_name, index) => {
      const system = systems[index];
      const app = createRuntimeGateway(system);
      system.faults.add(
        {
          name: 'temporary',
          matches: () => true,
          response: { status: 503, body: { code: 'TEMPORARY' } },
        },
        1_000,
      );
      await request(app)
        .get(`/resources/${_name.toLowerCase()}-none`)
        .expect(503, { code: 'TEMPORARY' });
      await request(app).post('/_admin/clock/advance').send({ ms: 1_001 }).expect(200);
      await request(app).get(`/resources/${_name.toLowerCase()}-none`).expect(404);
      system.faults.add({
        name: 'reset-me',
        matches: () => true,
        response: { status: 503, body: { code: 'RESET_ME' } },
      });
      await request(app).post('/_admin/reset').expect(204);
      await request(app).get(`/resources/${_name.toLowerCase()}-none`).expect(404);
      expect(system.clock.offsetMs()).toBe(0);
    },
  );
});
