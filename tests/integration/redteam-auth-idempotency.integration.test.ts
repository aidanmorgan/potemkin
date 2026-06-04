/**
 * Regression tests derived from red-team repros (converted to assert the FIXED
 * behaviour):
 *   - potemkin-uwuu: time-travel reads enforce required_scopes (no RBAC bypass).
 *   - potemkin-u6vw: idempotency key is actor-scoped (no cross-actor replay) and
 *     same-key/different-body returns 409.
 *   - potemkin-j0u4: concurrent same-key requests collapse to one execution.
 *   - potemkin-a60y: actor-override/impersonate preserves colon-bearing scopes.
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

const OPENAPI = `
openapi: "3.0.3"
info: { title: RedTeam, version: "1.0.0" }
paths:
  /vault/{id}:
    get:
      operationId: getVault
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        "200":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Vault" }
    post:
      operationId: createVault
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Vault" }
      responses:
        "201":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Vault" }
components:
  schemas:
    Vault:
      type: object
      properties:
        id: { type: string }
        secret: { type: string }
        balance: { type: number }
      required: [id, secret]
`;

const VAULT_DSL = `
boundary: Vault
contract_path: /vault/{id}
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: VaultCreated
    payload_template:
      id: "command.targetId"
      secret: "command.payload.secret"
  - type: VaultRead
    payload_template:
      id: "command.targetId"
behaviors:
  - name: create-vault
    match:
      operationId: createVault
      condition: "true"
      required_scopes: [vault:write]
    emit: VaultCreated
  - name: read-vault
    match:
      operationId: getVault
      condition: "true"
      required_scopes: [vault:read]
    emit: VaultRead
reducers:
  - on: VaultCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /secret, value: "\${event.payload.secret}" }
`;

const SIMPLE = `auth:\n  mode: simple\n`;
const IDEMPOTENT_GLOBAL = `${SIMPLE}idempotency:\n  enabled: true\n  hashIncludesBody: true\n`;

async function bootWith(globalYaml: string): Promise<PersistentAgent> {
  const openapi = await loadOpenApi(OPENAPI);
  const compiledDsl = await compileDsl([{ name: 'vault', yaml: VAULT_DSL }], globalYaml);
  const sys = await bootSystem({ openapi, compiledDsl });
  const app = createGateway(sys);
  const { agent, close } = await withPersistentServer(app);
  registerFileTeardown(close);
  return agent;
}

const vaultBody = (id: string) => ({ id, secret: 'TOPSECRET', balance: 100 });

async function seedVault(agent: PersistentAgent, scopesHeader: string): Promise<string> {
  const id = nextUuidv7();
  const res = await agent
    .post(`/vault/${id}`)
    .set('Authorization', scopesHeader)
    .send(vaultBody(id));
  if (res.status !== 201) {
    throw new Error(`seedVault failed: status=${res.status} body=${JSON.stringify(res.body)}`);
  }
  return id;
}

describe('potemkin-uwuu — time-travel reads enforce RBAC', () => {
  it('read-at-version time-travel on a scope-protected entity is rejected for an unscoped actor', async () => {
    const agent = await bootWith(SIMPLE);
    const id = await seedVault(agent, 'Bearer writer:vault:write');

    const res = await agent
      .get(`/vault/${id}`)
      .set('Authorization', 'Bearer attacker:nothing')
      .set('X-Potemkin-Read-At-Version', '1');

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('TOPSECRET');
  });

  it('read-at-version time-travel with the required scope still succeeds', async () => {
    const agent = await bootWith(SIMPLE);
    const id = await seedVault(agent, 'Bearer writer:vault:write');

    const res = await agent
      .get(`/vault/${id}`)
      .set('Authorization', 'Bearer reader:vault:read')
      .set('X-Potemkin-Read-At-Version', '1');

    expect(res.status).toBe(200);
  });
});

describe('potemkin-u6vw — idempotency is actor-scoped', () => {
  it('a different actor replaying another actor key+body is denied (no cached-response leak)', async () => {
    const agent = await bootWith(IDEMPOTENT_GLOBAL);
    const id = nextUuidv7();
    const key = 'shared-key-' + nextUuidv7();

    const aRes = await agent
      .post(`/vault/${id}`)
      .set('Authorization', 'Bearer alice:vault:write')
      .set('Idempotency-Key', key)
      .send({ id, secret: 'ALICE_SECRET' });
    expect(aRes.status).toBe(201);

    // Mallory (no vault:write) replays the SAME key + body. Because the key is
    // actor-scoped, Mallory's request is NOT served Alice's cached 201 — it is
    // re-authorized as Mallory and fails (no replay header, no secret leak).
    const bRes = await agent
      .post(`/vault/${id}`)
      .set('Authorization', 'Bearer mallory:nothing')
      .set('Idempotency-Key', key)
      .send({ id, secret: 'ALICE_SECRET' });

    // The decisive checks: no idempotency replay, no leaked cached body.
    expect(bRes.headers['x-idempotency-replay']).toBeUndefined();
    expect(bRes.status).not.toBe(201);
    expect(JSON.stringify(bRes.body)).not.toContain('ALICE_SECRET');
  });

  it('the SAME actor replaying the same key+body is served the cached response', async () => {
    const agent = await bootWith(IDEMPOTENT_GLOBAL);
    const id = nextUuidv7();
    const key = 'same-actor-' + nextUuidv7();

    const first = await agent
      .post(`/vault/${id}`)
      .set('Authorization', 'Bearer alice:vault:write')
      .set('Idempotency-Key', key)
      .send({ id, secret: 'ALICE_SECRET' });
    expect(first.status).toBe(201);

    const replay = await agent
      .post(`/vault/${id}`)
      .set('Authorization', 'Bearer alice:vault:write')
      .set('Idempotency-Key', key)
      .send({ id, secret: 'ALICE_SECRET' });
    expect(replay.status).toBe(201);
    expect(replay.headers['x-idempotency-replay']).toBe('true');
  });

  it('same actor+key with a DIFFERENT body returns 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
    const agent = await bootWith(IDEMPOTENT_GLOBAL);
    const id = nextUuidv7();
    const key = 'conflict-' + nextUuidv7();

    const first = await agent
      .post(`/vault/${id}`)
      .set('Authorization', 'Bearer alice:vault:write')
      .set('Idempotency-Key', key)
      .send({ id, secret: 'FIRST' });
    expect(first.status).toBe(201);

    const conflict = await agent
      .post(`/vault/${id}`)
      .set('Authorization', 'Bearer alice:vault:write')
      .set('Idempotency-Key', key)
      .send({ id, secret: 'DIFFERENT' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });
});

describe('potemkin-j0u4 — idempotency TOCTOU race collapses to one execution', () => {
  it('two concurrent requests with the same idempotency key produce exactly one effect', async () => {
    const agent = await bootWith(IDEMPOTENT_GLOBAL);
    const id = nextUuidv7();
    const key = 'race-' + nextUuidv7();
    const body = { id, secret: 'RACY' };

    // X-Potemkin-Force-Latency yields the event loop between the idempotency
    // check and record, opening the TOCTOU window deterministically.
    const [r1, r2] = await Promise.all([
      agent.post(`/vault/${id}`).set('Authorization', 'Bearer alice:vault:write').set('Idempotency-Key', key).set('X-Potemkin-Force-Latency', '50').send(body),
      agent.post(`/vault/${id}`).set('Authorization', 'Bearer alice:vault:write').set('Idempotency-Key', key).set('X-Potemkin-Force-Latency', '50').send(body),
    ]);

    const replays = [r1, r2].filter((r) => r.headers['x-idempotency-replay'] === 'true');
    expect(replays.length).toBe(1);
    // Both succeed and refer to the SAME entity id (one execution).
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(new Set([r1.body.id, r2.body.id]).size).toBe(1);
  });
});

describe('potemkin-a60y — actor-override preserves colon-bearing scopes', () => {
  it('admin impersonate grants a resource:action scope (vault:write) intact', async () => {
    const agent = await bootWith(SIMPLE);
    const id = nextUuidv7();
    const res = await agent
      .post(`/vault/${id}`)
      .set('Authorization', 'Bearer root:admin')
      .set('X-Potemkin-Impersonate', 'victim:vault:write')
      .send({ id, secret: 'X' });

    // With correct parsing the impersonated actor has scope ['vault:write'] → 201.
    expect(res.status).toBe(201);
  });
});
