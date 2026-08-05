import {
  boundaryName,
  behaviorName,
  contractPath,
  eventType,
  operationId,
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
info: { title: Clock offset parity, version: "1.0.0" }
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
components:
  schemas:
    RecordInput:
      type: object
      required: [label]
      properties: { label: { type: string } }
    Record:
      type: object
      required: [id, label, recordedAt]
      properties:
        id: { type: string }
        label: { type: string }
        recordedAt: { type: string }
`;

const YAML = `
boundary: Record
contract_path: /records
identity:
  creation:
    generate: $uuidv7()
event_catalog:
  - type: RecordCreated
    payload_template:
      id: command.targetId
      label: command.payload.label
      recordedAt: $now()
behaviors:
  - name: create-record
    match: { operationId: createRecord, condition: "true" }
    emit: RecordCreated
reducers:
  - on: RecordCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /label, value: "\${event.payload.label}" }
      - { op: replace, path: /recordedAt, value: "\${event.payload.recordedAt}" }
`;

function typescriptDefinition() {
  return simulation()
    .boundary(
      boundary(boundaryName('Record'), contractPath(pathSegment('records')))
        .identity({
          generate: expression('identity', ({ helpers }: IdentityContext) => helpers.uuid()),
        })
        .eventCatalog(
          event(eventType('RecordCreated'), {
            id: expression('event', ({ command }: EventContext) => String(command.targetId)),
            label: expression('event', ({ command }: EventContext) => command.payload.label),
            recordedAt: expression('event', ({ helpers }: EventContext) => helpers.now()),
          }),
        )
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
              recordedAt: emitted.payload.recordedAt,
            }))
            .build(),
        ),
    )
    .build();
}

async function bootPair(): Promise<[RuntimeSystem, RuntimeSystem]> {
  const openapi = await loadOpenApi(OPENAPI);
  return Promise.all([
    bootYamlRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      yamlProgram: { modules: [{ name: 'record.yaml', yaml: YAML }] },
    }),
    bootRuntime({
      host: createDefaultRuntimeHost(),
      openapi,
      programFactory: ({ dependencies }) =>
        compileProgram(typescriptDefinition(), { dependencies, openapi }),
    }),
  ]);
}

describe('request-local clock offset parity', () => {
  it('changes generated time only for the request and does not advance the shared clock', async () => {
    const [yamlSystem, typescriptSystem] = await bootPair();
    try {
      const yamlApp = createRuntimeGateway(yamlSystem);
      const typescriptApp = createRuntimeGateway(typescriptSystem);
      const readPair = async (app: ReturnType<typeof createRuntimeGateway>) => {
        const offset = await request(app)
          .post('/records')
          .set('X-Potemkin-Clock-Offset', '60000')
          .send({ label: 'offset' });
        const normal = await request(app).post('/records').send({ label: 'normal' });
        expect(offset.status).toBe(201);
        expect(normal.status).toBe(201);
        return [
          Date.parse(offset.body.recordedAt as string),
          Date.parse(normal.body.recordedAt as string),
        ] as const;
      };
      const [yamlTimes, typescriptTimes] = await Promise.all([
        readPair(yamlApp),
        readPair(typescriptApp),
      ]);

      expect(yamlTimes[0] - yamlTimes[1]).toBeGreaterThanOrEqual(59_000);
      expect(typescriptTimes[0] - typescriptTimes[1]).toBeGreaterThanOrEqual(59_000);
      expect(
        Math.abs(yamlTimes[0] - yamlTimes[1] - (typescriptTimes[0] - typescriptTimes[1])),
      ).toBeLessThan(2_000);
      expect(
        (await request(yamlApp).post('/_admin/clock/advance').send({ ms: 0 })).body.offsetMs,
      ).toBe(0);
      expect(
        (await request(typescriptApp).post('/_admin/clock/advance').send({ ms: 0 })).body.offsetMs,
      ).toBe(0);
    } finally {
      await Promise.all([yamlSystem.dispose(), typescriptSystem.dispose()]);
    }
  });
});
