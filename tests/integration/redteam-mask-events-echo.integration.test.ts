/**
 * Regression test derived from a red-team repro (mask-leak channel c), converted
 * to assert the FIXED behaviour:
 *   - potemkin-n0fa: masked (DSL `mask:`) fields do NOT leak through the
 *     X-Potemkin-Include-Events `_events[].payload` envelope on a normal response.
 *
 * /_admin/* surfaces still expose raw state/events (trusted-only) and are not
 * asserted here.
 */

import { bootSystem } from '../../src/engine/boot.js';
import { createGateway } from '../../src/http/gateway.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import {
  withPersistentServer,
  type PersistentAgent,
} from '../_support/persistentAgent.js';
import { registerFileTeardown } from '../_support/testTeardown.js';

const SECRET = 'TOP-SECRET-PII-do-not-leak';

const OPENAPI = `
openapi: "3.0.3"
info: { title: Mask Leak Test, version: "1.0.0" }
paths:
  /reports/{id}:
    post:
      operationId: createReport
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: "#/components/schemas/Report" } } }
      responses:
        "201": { content: { application/json: { schema: { $ref: "#/components/schemas/Report" } } } }
    get:
      operationId: getReport
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses:
        "200": { content: { application/json: { schema: { $ref: "#/components/schemas/Report" } } } }
components:
  schemas:
    Report:
      type: object
      properties:
        id: { type: string }
        title: { type: string }
        secret: { type: string }
`;

const DSL = `
boundary: Report
contract_path: /reports/{id}
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
mask:
  - secret
event_catalog:
  - type: ReportCreated
    payload_template:
      id: "command.targetId"
      title: "command.payload.title"
      secret: "command.payload.secret"
behaviors:
  - name: create-report
    match: { operationId: createReport, condition: "true" }
    emit: ReportCreated
  - name: get-report
    match: { operationId: getReport, condition: "true" }
    emit: ReportCreated
reducers:
  - on: ReportCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /title, value: "\${event.payload.title}" }
      - { op: replace, path: /secret, value: "\${event.payload.secret}" }
`;

let agent: PersistentAgent;

beforeAll(async () => {
  const openapi = await loadOpenApi(OPENAPI);
  const sys = await bootSystem({ openapi, compiledDsl: await compileDsl([{ name: 'report', yaml: DSL }]) });
  const app = createGateway(sys);
  const persistent = await withPersistentServer(app);
  agent = persistent.agent;
  registerFileTeardown(persistent.close);
});

describe('potemkin-n0fa — X-Potemkin-Include-Events does not leak masked fields', () => {
  it('the _events envelope on a normal response has the masked field removed from payloads', async () => {
    const id = nextUuidv7();
    const res = await agent
      .post(`/reports/${id}`)
      .set('X-Potemkin-Include-Events', 'true')
      .send({ title: 'Q1', secret: SECRET });

    expect(res.status).toBe(201);
    // The response body itself is masked (baseline).
    expect(res.body.secret).toBeUndefined();
    // The echoed event payloads must NOT carry the secret either.
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    // And _events is actually present (so the assertion is not vacuous).
    expect(Array.isArray(res.body._events)).toBe(true);
    expect(res.body._events.length).toBeGreaterThan(0);
    expect(res.body._events[0].payload.secret).toBeUndefined();
  });

  it('the forwarding _events envelope also strips the masked field', async () => {
    const id = nextUuidv7();
    const fwd = await agent
      .post('/_engine/forward')
      .send({
        method: 'POST',
        path: `/reports/${id}`,
        headers: { 'x-potemkin-include-events': 'true' },
        query: {},
        body: { title: 'Q1', secret: SECRET },
      })
      .expect(200);
    const env = fwd.body as { status: number; body: Record<string, unknown> };
    expect(env.status).toBe(201);
    // NOTE: on the forwarding path the response BODY is the unmasked BASE — the
    // mask travels in _patches for the plugin to apply. The echoed EVENT payloads,
    // however, must already have the masked field removed (they carry no patches).
    const events = env.body._events as Array<{ payload: Record<string, unknown> }>;
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].payload.secret).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });
});
