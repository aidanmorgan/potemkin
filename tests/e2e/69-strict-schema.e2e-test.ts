/**
 * 69 — strict_schema boundary flag (engine-only).
 *
 * Demonstrates `strict_schema: false` declared in a boundary DSL file.
 * The flag controls the INCOMPLETE_DEPS check in per-boundary schema inference:
 * a computed field whose formula references a state variable absent from its
 * `depends_on` list has an incomplete dependency declaration.
 *
 *   strict_schema omitted / true (default):
 *     Boot throws BOOT_ERR_COMPUTED_FIELD_INCOMPLETE_DEPS. The boundary is
 *     rejected at startup — the incomplete declaration is treated as an error.
 *
 *   strict_schema: false:
 *     Boot logs a WARN and continues. The engine starts successfully. The
 *     computed field's formula still executes at runtime (referencing the
 *     undeclared dep), but the dependency tracking may be stale if only the
 *     undeclared dep is updated.
 *
 * Fixture: tests/fixtures/strict-schema/
 *   OrderItem boundary (/order-items) — strict_schema: false
 *     Computed field `lineTotal = state.quantity * state.unitPrice`
 *     depends_on: [unitPrice]   ← quantity is intentionally absent
 *
 * The fixture demonstrates the non-strict variant (the one that boots).
 * The strict-mode boot failure is demonstrated via an inline compileDsl +
 * bootSystem call in the second describe block.
 */

import * as path from 'node:path';
import { startEngineOnlyApp } from './_harness/engine-only-app';
import type { EngineOnlyApp } from './_harness/engine-only-app';
import { fwd } from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';
import { bootSystem } from '../../src/engine/boot';
import { loadOpenApi } from '../../src/contract/loader';
import { compileDsl } from '../../src/dsl/parser';
import { BootError } from '../../src/errors';

describe('69 — strict_schema boundary flag (engine-only)', () => {
  describe('OrderItem boundary (strict_schema: false) — non-strict mode boots and warns', () => {
    let app: EngineOnlyApp;

    beforeAll(async () => {
      app = await startEngineOnlyApp({ fixtureName: 'strict-schema' });
    }, 120_000);

    afterAll(async () => {
      await app.shutdown();
    }, 30_000);

    it('engine boots successfully despite the incomplete depends_on declaration', async () => {
      // The fixture boundary declares lineTotal with depends_on: [unitPrice],
      // but the formula also references state.quantity. In strict mode this is a
      // boot error; with strict_schema: false the engine starts normally.
      const res = await fetch(`${app.engineUrl}/_admin/health`);
      expect(res.status).toBe(200);
    }, 30_000);

    it('POST /order-items creates an entity and returns 201', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/order-items', {
        description: 'Widget',
        quantity: 3,
        unitPrice: 10,
      });
      expect(res.status).toBe(201);
      const body = res.body as JsonObject;
      expect(typeof body['id']).toBe('string');
      expect((body['id'] as string).length).toBeGreaterThan(0);
    }, 30_000);

    it('computed lineTotal is present on the created entity', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/order-items', {
        description: 'Gadget',
        quantity: 4,
        unitPrice: 5,
      });
      expect(res.status).toBe(201);
      const body = res.body as JsonObject;
      // lineTotal = quantity * unitPrice = 4 * 5 = 20.
      // unitPrice is in depends_on so the reducer patch to /unitPrice triggers
      // recomputation. The formula evaluates correctly at runtime.
      expect(body['lineTotal']).toBe(20);
    }, 30_000);
  });

  describe('BOOT_ERR_COMPUTED_FIELD_INCOMPLETE_DEPS — strict mode (default) rejects incomplete depends_on', () => {
    it('boot fails when strict_schema is omitted and depends_on is incomplete', async () => {
      // Load the same OpenAPI spec the fixture uses — only the DSL changes.
      const openapi = await loadOpenApi(
        path.resolve(__dirname, '..', 'fixtures', 'strict-schema', 'openapi', 'strict-schema-demo.yaml'),
      );

      // Same boundary as the fixture but WITHOUT strict_schema: false. The
      // default is strict, so the incomplete depends_on declaration is an error.
      const dsl = await compileDsl([
        {
          name: 'order-item-strict.yaml',
          yaml: `
boundary: OrderItem
contract_path: /order-items
fallback_override: false
identity:
  creation:
    generate: $uuidv7()
event_catalog:
  - type: OrderItemCreated
    payload_template:
      id: "command.targetId"
      description: "command.payload.description"
      quantity: "command.payload.quantity"
      unitPrice: "command.payload.unitPrice"
state:
  computed:
    - name: lineTotal
      formula: "state.quantity * state.unitPrice"
      depends_on:
        - unitPrice
behaviors:
  - name: createOrderItem
    match:
      operationId: createOrderItem
      condition: "true"
    emit: OrderItemCreated
reducers:
  - on: OrderItemCreated
    patches:
      - op: replace
        path: /id
        value: "\${event.payload.id}"
      - op: replace
        path: /description
        value: "\${event.payload.description}"
      - op: replace
        path: /quantity
        value: "\${event.payload.quantity}"
      - op: replace
        path: /unitPrice
        value: "\${event.payload.unitPrice}"
initialization: []
`,
        },
      ]);

      let code: string | undefined;
      try {
        await bootSystem({ openapi, compiledDsl: dsl });
      } catch (e) {
        code = e instanceof BootError ? e.code : undefined;
      }
      // strict mode (the default): boot must fail with INCOMPLETE_DEPS
      expect(code).toBe('BOOT_ERR_COMPUTED_FIELD_INCOMPLETE_DEPS');
    }, 30_000);

    it('boot fails when strict_schema: true is explicit and depends_on is incomplete', async () => {
      const openapi = await loadOpenApi(
        path.resolve(__dirname, '..', 'fixtures', 'strict-schema', 'openapi', 'strict-schema-demo.yaml'),
      );

      // Same boundary as before but strict_schema: true is stated explicitly.
      const dsl = await compileDsl([
        {
          name: 'order-item-strict-explicit.yaml',
          yaml: `
boundary: OrderItem
contract_path: /order-items
fallback_override: false
strict_schema: true
identity:
  creation:
    generate: $uuidv7()
event_catalog:
  - type: OrderItemCreated
    payload_template:
      id: "command.targetId"
      description: "command.payload.description"
      quantity: "command.payload.quantity"
      unitPrice: "command.payload.unitPrice"
state:
  computed:
    - name: lineTotal
      formula: "state.quantity * state.unitPrice"
      depends_on:
        - unitPrice
behaviors:
  - name: createOrderItem
    match:
      operationId: createOrderItem
      condition: "true"
    emit: OrderItemCreated
reducers:
  - on: OrderItemCreated
    patches:
      - op: replace
        path: /id
        value: "\${event.payload.id}"
      - op: replace
        path: /description
        value: "\${event.payload.description}"
      - op: replace
        path: /quantity
        value: "\${event.payload.quantity}"
      - op: replace
        path: /unitPrice
        value: "\${event.payload.unitPrice}"
initialization: []
`,
        },
      ]);

      let code: string | undefined;
      try {
        await bootSystem({ openapi, compiledDsl: dsl });
      } catch (e) {
        code = e instanceof BootError ? e.code : undefined;
      }
      // strict_schema: true is explicit — same rejection as the default
      expect(code).toBe('BOOT_ERR_COMPUTED_FIELD_INCOMPLETE_DEPS');
    }, 30_000);
  });
});
