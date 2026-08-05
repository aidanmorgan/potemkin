import {
  boundaryName,
  behaviorName,
  contractPath,
  eventType,
  operationId,
  pathParameter,
  pathSegment,
} from '../../src/domain/references.js';
import request from 'supertest';
import { loadOpenApi } from '../../src/contract/loader.js';
import { createRuntimeGateway } from '../../src/http/runtimeGateway.js';
import { bootRuntime, type RuntimeSystem } from '../../src/runtime/system.js';
import { createDefaultRuntimeHost } from '../../src/runtime/host.js';
import { bootYamlRuntime } from '../../src/parser/runtime.js';
import { boundary, event, expression, simulation } from '../../src/authoring/builders.js';
import { compileProgram } from '../../src/authoring/compiler.js';
import { reducerRule } from '../../src/authoring/nativeReducer.js';
import type { EventContext, IdentityContext } from '../../src/model/runtime.js';

const OPENAPI = `
openapi: "3.0.3"
info: { title: Time travel parity, version: "1.0.0" }
paths:
  /records:
    post:
      operationId: createRecord
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/RecordInput" }
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Record" }
  /records/{id}:
    get:
      operationId: getRecord
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses:
        "200":
          description: Current record
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Record" }
    put:
      operationId: updateRecord
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/RecordInput" }
      responses:
        "200":
          description: Updated
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Record" }
components:
  schemas:
    RecordInput:
      type: object
      required: [label]
      properties: { label: { type: string } }
    Record:
      type: object
      required: [id, label]
      properties:
        id: { type: string }
        label: { type: string }
`;

const YAML = `
boundary: Record
contract_path: /records
identity:
  creation:
    generate: $uuidv7()
event_catalog:
  - type: RecordCreated
    payload_template: { id: command.targetId, label: command.payload.label }
behaviors:
  - { name: create-record, match: { operationId: createRecord, condition: "true" }, emit: RecordCreated }
reducers:
  - on: RecordCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /label, value: "\${event.payload.label}" }
`;

const YAML_BY_ID = `
boundary: RecordById
contract_path: /records/{id}
fallback_override: true
event_catalog:
  - type: RecordUpdated
    payload_template: { id: command.targetId, label: command.payload.label }
behaviors:
  - { name: update-record, match: { operationId: updateRecord, condition: "true" }, emit: RecordUpdated }
reducers:
  - on: RecordUpdated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /label, value: "\${event.payload.label}" }
`;

const YAML_GLOBAL = `
idempotency:
  enabled: true
  ttl_seconds: 60
  hash_includes_body: true
`;

function typescriptDefinition() {
  const createEvent = event(eventType('RecordCreated'), {
    id: expression('event', ({ command }: EventContext) => String(command.targetId)),
    label: expression('event', ({ command }: EventContext) => command.payload.label),
  });
  const updateEvent = event(eventType('RecordUpdated'), {
    id: expression('event', ({ command }: EventContext) => String(command.targetId)),
    label: expression('event', ({ command }: EventContext) => command.payload.label),
  });
  return simulation()
    .boundary(
      boundary(boundaryName('Record'), contractPath(pathSegment('records')))
        .identity({
          generate: expression('identity', ({ helpers }: IdentityContext) => helpers.uuid()),
        })
        .eventCatalog(createEvent)
        .behavior({
          name: behaviorName('create-record'),
          operationId: operationId('createRecord'),
          condition: expression('behavior', () => true),
          emit: eventType('RecordCreated'),
        })
        .reducer(
          reducerRule(eventType('RecordCreated'))
            .apply(({ state, event: emitted }) => ({
              ...state,
              id: emitted.payload.id,
              label: emitted.payload.label,
            }))
            .build(),
        ),
    )
    .boundary(
      boundary(
        boundaryName('RecordById'),
        contractPath(pathSegment('records'), pathParameter('id')),
      )
        .fallbackOverride()
        .eventCatalog(updateEvent)
        .behavior({
          name: behaviorName('update-record'),
          operationId: operationId('updateRecord'),
          condition: expression('behavior', () => true),
          emit: eventType('RecordUpdated'),
        })
        .reducer(
          reducerRule(eventType('RecordUpdated'))
            .apply(({ state, event: emitted }) => ({
              ...state,
              id: emitted.payload.id,
              label: emitted.payload.label,
            }))
            .build(),
        ),
    )
    .global({ idempotency: { enabled: true, ttlSeconds: 60, hashIncludesBody: true } })
    .build();
}

async function bootPair(): Promise<[RuntimeSystem, RuntimeSystem]> {
  const openapi = await loadOpenApi(OPENAPI);
  return Promise.all([
    bootYamlRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      yamlProgram: {
        modules: [
          { name: 'record.yaml', yaml: YAML },
          { name: 'record-by-id.yaml', yaml: YAML_BY_ID },
        ],
        globalYaml: YAML_GLOBAL,
      },
    }),
    bootRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      programFactory: ({ dependencies }) =>
        compileProgram(typescriptDefinition(), { dependencies, openapi }),
    }),
  ]);
}

describe('read-at-version and replay parity', () => {
  it('keeps historical reads isolated and replays known/unknown events deterministically', async () => {
    const [yamlSystem, typescriptSystem] = await bootPair();
    const yamlApp = createRuntimeGateway(yamlSystem);
    const typescriptApp = createRuntimeGateway(typescriptSystem);
    try {
      const [yamlCreated, typescriptCreated] = await Promise.all([
        request(yamlApp)
          .post('/records')
          .set('X-Potemkin-Seed', 'time-travel-seed')
          .send({ label: 'created' }),
        request(typescriptApp)
          .post('/records')
          .set('X-Potemkin-Seed', 'time-travel-seed')
          .send({ label: 'created' }),
      ]);
      expect(yamlCreated.status).toBe(201);
      expect(typescriptCreated.body).toEqual(yamlCreated.body);
      const id = yamlCreated.body.id as string;
      const [yamlUpdated, typescriptUpdated] = await Promise.all([
        request(yamlApp).put(`/records/${id}`).send({ label: 'updated' }),
        request(typescriptApp).put(`/records/${id}`).send({ label: 'updated' }),
      ]);
      expect(yamlUpdated.status).toBe(200);
      expect(typescriptUpdated.body).toEqual(yamlUpdated.body);

      const [yamlHistorical, typescriptHistorical] = await Promise.all([
        request(yamlApp).get(`/records/${id}`).set('X-Potemkin-Read-At-Version', '1'),
        request(typescriptApp).get(`/records/${id}`).set('X-Potemkin-Read-At-Version', '1'),
      ]);
      expect(yamlHistorical.status).toBe(200);
      expect(yamlHistorical.body.label).toBe('created');
      expect(typescriptHistorical.body).toEqual(yamlHistorical.body);
      expect(yamlHistorical.headers.etag).toBe('"1"');
      expect(yamlHistorical.headers['last-modified']).toBeDefined();
      expect(yamlSystem.engine.snapshot().events).toHaveLength(2);
      expect(typescriptSystem.engine.snapshot().events).toHaveLength(2);

      const eventId = yamlSystem.engine.snapshot().events[0]!.eventId;
      const [yamlReplay, typescriptReplay] = await Promise.all([
        request(yamlApp).get(`/records/${id}`).set('X-Potemkin-Replay-Event', eventId),
        request(typescriptApp).get(`/records/${id}`).set('X-Potemkin-Replay-Event', eventId),
      ]);
      expect(yamlReplay.status).toBe(200);
      expect(typescriptReplay.body).toEqual(yamlReplay.body);
      expect(yamlReplay.headers['x-potemkin-replayed-event']).toBe(eventId);
      expect(yamlSystem.engine.snapshot().events).toHaveLength(3);
      expect(typescriptSystem.engine.snapshot().events).toHaveLength(3);

      const typescriptEventId = typescriptSystem.engine.snapshot().events[0]!.eventId;
      const [yamlReplayAgain, typescriptReplayAgain] = await Promise.all([
        request(yamlApp)
          .get(`/records/${id}`)
          .set('X-Potemkin-Replay-Event', eventId)
          .set('Idempotency-Key', 'replay-once'),
        request(typescriptApp)
          .get(`/records/${id}`)
          .set('X-Potemkin-Replay-Event', typescriptEventId)
          .set('Idempotency-Key', 'replay-once'),
      ]);
      expect(yamlReplayAgain.status).toBe(200);
      expect(typescriptReplayAgain.status).toBe(200);
      expect(yamlReplayAgain.headers['x-idempotency-replay']).toBeUndefined();
      expect(typescriptReplayAgain.headers['x-idempotency-replay']).toBeUndefined();

      await request(yamlApp)
        .get(`/records/${id}`)
        .set('X-Potemkin-Replay-Event', eventId)
        .set('Idempotency-Key', 'replay-once')
        .expect(200);
      await request(typescriptApp)
        .get(`/records/${id}`)
        .set('X-Potemkin-Replay-Event', typescriptEventId)
        .set('Idempotency-Key', 'replay-once')
        .expect(200);
      expect(yamlSystem.engine.snapshot().events).toHaveLength(4);
      expect(typescriptSystem.engine.snapshot().events).toHaveLength(4);

      const [yamlMissing, typescriptMissing] = await Promise.all([
        request(yamlApp).get(`/records/${id}`).set('X-Potemkin-Replay-Event', 'missing-event'),
        request(typescriptApp)
          .get(`/records/${id}`)
          .set('X-Potemkin-Replay-Event', 'missing-event'),
      ]);
      expect(yamlMissing.status).toBe(404);
      expect(typescriptMissing.body).toEqual(yamlMissing.body);
      expect(yamlSystem.engine.snapshot().events).toHaveLength(4);
      expect(typescriptSystem.engine.snapshot().events).toHaveLength(4);
    } finally {
      await Promise.all([yamlSystem.dispose(), typescriptSystem.dispose()]);
    }
  });
});
