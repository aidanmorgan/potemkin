/**
 * schema-static-check.integration.test.ts
 *
 * Integration test: boot with a DSL referencing an unknown state path;
 * assert BootError with code BOOT_ERR_DSL_SCHEMA_VIOLATION.
 */

import { bootSystem } from '../../src/engine/boot.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import { BootError } from '../../src/errors.js';

// ---------------------------------------------------------------------------
// Minimal OpenAPI with a single Customer schema
// ---------------------------------------------------------------------------
const MINIMAL_OPENAPI = `
openapi: "3.0.3"
info:
  title: Schema Check Test
  version: "1.0.0"
paths:
  /widgets:
    post:
      operationId: createWidget
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Widget"
      responses:
        "201":
          description: Widget created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Widget"
components:
  schemas:
    Widget:
      type: object
      properties:
        id:
          type: string
        name:
          type: string
      required:
        - id
        - name
`;

// DSL that references an unknown path (state.DOES_NOT_EXIST) in a behavior condition
const BAD_DSL_UNKNOWN_STATE_PATH = `
boundary: Widget
contract_path: /widgets
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: WidgetCreated
    payload_template:
      id: "command.targetId"
      name: "command.payload.name"
behaviors:
  - name: create-widget
    match:
      operationId: createWidget
      condition: "state.DOES_NOT_EXIST == 'foobar'"
    emit: WidgetCreated
reducers:
  - on: WidgetCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /name, value: "\${event.payload.name}" }
`;

// A well-formed DSL for the same boundary (sanity check)
const GOOD_DSL = `
boundary: Widget
contract_path: /widgets
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: WidgetCreated
    payload_template:
      id: "command.targetId"
      name: "command.payload.name"
behaviors:
  - name: create-widget
    match:
      operationId: createWidget
      condition: "true"
    emit: WidgetCreated
reducers:
  - on: WidgetCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /name, value: "\${event.payload.name}" }
`;

describe('schema-static-check.integration: DSL with unknown state path triggers boot error', () => {
  it('bootSystem throws BootError when DSL references an unknown state path', async () => {
    const openapi = await loadOpenApi(MINIMAL_OPENAPI);

    await expect(
      bootSystem({
        openapi,
        compiledDsl: await compileDsl([{ name: 'widget', yaml: BAD_DSL_UNKNOWN_STATE_PATH }]),
      }),
    ).rejects.toBeInstanceOf(BootError);
  });

  it('the BootError has code BOOT_ERR_DSL_SCHEMA_VIOLATION', async () => {
    const openapi = await loadOpenApi(MINIMAL_OPENAPI);

    try {
      await bootSystem({
        openapi,
        compiledDsl: await compileDsl([{ name: 'widget', yaml: BAD_DSL_UNKNOWN_STATE_PATH }]),
      });
      fail('Expected BootError');
    } catch (err) {
      expect(err).toBeInstanceOf(BootError);
      expect((err as BootError).code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    }
  });

  it('the BootError details include the violations', async () => {
    const openapi = await loadOpenApi(MINIMAL_OPENAPI);

    try {
      await bootSystem({
        openapi,
        compiledDsl: await compileDsl([{ name: 'widget', yaml: BAD_DSL_UNKNOWN_STATE_PATH }]),
      });
      fail('Expected BootError');
    } catch (err) {
      const bootErr = err as BootError;
      expect(bootErr.details).toBeDefined();
      const details = bootErr.details as Record<string, unknown>;
      expect(details['violations']).toBeDefined();
      const violations = details['violations'] as unknown[];
      expect(violations.length).toBeGreaterThan(0);
    }
  });

  it('a well-formed DSL boots successfully without errors', async () => {
    const openapi = await loadOpenApi(MINIMAL_OPENAPI);

    await expect(
      bootSystem({
        openapi,
        compiledDsl: await compileDsl([{ name: 'widget', yaml: GOOD_DSL }]),
      }),
    ).resolves.toBeDefined();
  });
});
