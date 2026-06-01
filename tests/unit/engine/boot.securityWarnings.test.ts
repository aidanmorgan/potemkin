/**
 * Boot-time security warning tests
 *
 * Verifies:
 *  1. A single WARN is emitted at boot when ADMIN_TOKEN is unset.
 *     The warning is suppressed when ADMIN_TOKEN is set.
 *  2. A WARN is emitted when scoped behaviors exist but auth.mode != jwt.
 *     The warning is NOT emitted when auth.mode is jwt.
 */

import pino from 'pino';
import { bootSystem } from '../../../src/engine/boot.js';
import { loadOpenApi } from '../../../src/contract/loader.js';
import { compileDsl } from '../../../src/dsl/parser.js';

// ── Shared minimal OpenAPI ────────────────────────────────────────────────────

const MINIMAL_OPENAPI = `
openapi: "3.0.3"
info:
  title: Security Warning Test
  version: "1.0.0"
paths:
  /things:
    post:
      operationId: createThing
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Thing"
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Thing"
components:
  schemas:
    Thing:
      type: object
      properties:
        id:
          type: string
        name:
          type: string
`;

// DSL with no scoped behaviors — baseline
const PLAIN_DSL = `
boundary: Thing
contract_path: /things
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: ThingCreated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: create-thing
    match:
      operationId: createThing
      condition: "true"
    emit: ThingCreated
reducers:
  - on: ThingCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
`;

// DSL with a scoped behavior
const SCOPED_DSL = `
boundary: Thing
contract_path: /things
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: ThingCreated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: create-thing
    match:
      operationId: createThing
      condition: "true"
      required_scopes:
        - writer
    emit: ThingCreated
reducers:
  - on: ThingCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
`;

// Global config with jwt auth mode — scoped behaviors + jwt should NOT trigger warning
const JWT_GLOBAL_CONFIG = `
auth:
  mode: jwt
  jwt:
    secret: "test-secret-for-unit-test"
`;

/** Build a pino Logger that captures all warn-level messages. */
function capturingLogger(): { logger: pino.Logger; warnings: string[] } {
  const warnings: string[] = [];
  const stream = {
    write(line: string) {
      const record = JSON.parse(line) as { level: number; msg?: string };
      // pino warn level = 40
      if (record.level >= 40) warnings.push(record.msg ?? '');
    },
  };
  return { logger: pino({ level: 'trace' }, stream), warnings };
}

// ── ADMIN_TOKEN unset warning ─────────────────────────────────────────────────

describe('boot security warning — ADMIN_TOKEN unset', () => {
  const savedAdminToken = process.env['ADMIN_TOKEN'];

  afterEach(() => {
    if (savedAdminToken === undefined) {
      delete process.env['ADMIN_TOKEN'];
    } else {
      process.env['ADMIN_TOKEN'] = savedAdminToken;
    }
  });

  it('emits a WARN containing ADMIN_TOKEN when ADMIN_TOKEN is unset', async () => {
    delete process.env['ADMIN_TOKEN'];
    const openapi = await loadOpenApi(MINIMAL_OPENAPI);
    const { logger, warnings } = capturingLogger();

    await bootSystem({
      openapi,
      compiledDsl: await compileDsl([{ name: 'thing', yaml: PLAIN_DSL }]),
      logger,
    });

    const adminWarning = warnings.find((w) => w.includes('ADMIN_TOKEN'));
    expect(adminWarning).toBeDefined();
    expect(adminWarning).toContain('unauthenticated');
  });

  it('does NOT emit the ADMIN_TOKEN warning when ADMIN_TOKEN is set', async () => {
    process.env['ADMIN_TOKEN'] = 'super-secret';
    const openapi = await loadOpenApi(MINIMAL_OPENAPI);
    const { logger, warnings } = capturingLogger();

    await bootSystem({
      openapi,
      compiledDsl: await compileDsl([{ name: 'thing', yaml: PLAIN_DSL }]),
      logger,
    });

    const adminWarning = warnings.find((w) => w.includes('ADMIN_TOKEN'));
    expect(adminWarning).toBeUndefined();
  });
});

// ── scoped behaviors with non-jwt auth ───────────────────────────────────────

describe('boot security warning — scoped behaviors with non-jwt auth', () => {
  it('emits a WARN when scoped behaviors exist and auth.mode is not jwt', async () => {
    const openapi = await loadOpenApi(MINIMAL_OPENAPI);
    const { logger, warnings } = capturingLogger();

    await bootSystem({
      openapi,
      compiledDsl: await compileDsl([{ name: 'thing', yaml: SCOPED_DSL }]),
      logger,
    });

    const scopeWarning = warnings.find(
      (w) => w.toLowerCase().includes('scope') && w.toLowerCase().includes('bypassable'),
    );
    expect(scopeWarning).toBeDefined();
  });

  it('does NOT emit the scope warning when auth.mode is jwt', async () => {
    const openapi = await loadOpenApi(MINIMAL_OPENAPI);
    const { logger, warnings } = capturingLogger();

    await bootSystem({
      openapi,
      compiledDsl: await compileDsl(
        [{ name: 'thing', yaml: SCOPED_DSL }],
        JWT_GLOBAL_CONFIG,
      ),
      logger,
    });

    const scopeWarning = warnings.find(
      (w) => w.toLowerCase().includes('scope') && w.toLowerCase().includes('bypassable'),
    );
    expect(scopeWarning).toBeUndefined();
  });

  it('does NOT emit the scope warning when no scoped behaviors exist', async () => {
    const openapi = await loadOpenApi(MINIMAL_OPENAPI);
    const { logger, warnings } = capturingLogger();

    await bootSystem({
      openapi,
      compiledDsl: await compileDsl([{ name: 'thing', yaml: PLAIN_DSL }]),
      logger,
    });

    const scopeWarning = warnings.find(
      (w) => w.toLowerCase().includes('scope') && w.toLowerCase().includes('bypassable'),
    );
    expect(scopeWarning).toBeUndefined();
  });
});
