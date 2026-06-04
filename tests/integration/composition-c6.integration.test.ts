/**
 * Integration tests for C6: three-phase validation reorg.
 *
 * Verifies:
 *  1. A component reducer that is intra-valid but binding-dependent passes Phase 1
 *     (no OpenAPI/object-graph error at parse time). The inert component file compiles
 *     cleanly even though it references a JSON-Pointer path that can only be validated
 *     against an OpenAPI schema once a contract_path is bound.
 *  2. After instantiating that component via use: onto a real contract_path, the
 *     binding-dependent check runs at Phase 3 (boot):
 *       a. When the reducer patch path is valid for the bound schema → boot succeeds.
 *       b. When the reducer patch path is invalid for the bound schema → boot fails
 *          with BOOT_ERR_DSL_SCHEMA_VIOLATION (the existing static-check error code).
 *  3. A genuinely invalid cross-reference in the LINKED model (a reaction whose
 *     reacting boundary does not exist) still fails at Phase 3 with BOOT_ERR_DSL_REFERENCE.
 *  4. Non-composed fixtures (boundary files only) behave exactly as before — the full
 *     suite is the primary proof, but this file includes a representative smoke test.
 *
 * The Phase-3 checks that are exercised here are all existing boot-time checks — no new
 * validation logic is added. The C6 contract is that these checks run on the post-link
 * flat model and are NOT applied to inert components.
 */

import { bootSystem } from '../../src/engine/boot.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';

// ---------------------------------------------------------------------------
// Shared OpenAPI spec for all C6 tests
// ---------------------------------------------------------------------------

const OPENAPI_YAML = `
openapi: "3.0.3"
info:
  title: C6 Validation Phasing Test
  version: "1.0.0"
paths:
  /widgets/{id}:
    post:
      operationId: createWidget
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: false
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Widget" }
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Widget" }
    get:
      operationId: getWidget
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Widget" }
  /gadgets/{id}:
    post:
      operationId: createGadget
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: false
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Gadget" }
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Gadget" }
    get:
      operationId: getGadget
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Gadget" }
components:
  schemas:
    Widget:
      type: object
      properties:
        id:     { type: string }
        status: { type: string }
      required: [id, status]
    Gadget:
      type: object
      properties:
        id:     { type: string }
        name:   { type: string }
      required: [id, name]
`;

// ---------------------------------------------------------------------------
// Component with a binding-dependent reducer patch path.
// The path "/status" is valid for the Widget schema but unknown for Gadget.
// At Phase 1, the component has no contract_path, so no schema check runs —
// the component compiles cleanly regardless.
// ---------------------------------------------------------------------------

const BINDING_DEPENDENT_COMPONENT_YAML = `
kind: component
name: StatusEntity
parameters:
  operationId:
    type: string
    required: true
event_catalog:
  - type: StatusSet
    payload_template:
      id: "command.targetId"
      status: "'ACTIVE'"
behaviors:
  - name: create
    match:
      operationId: "{{operationId}}"
      condition: "true"
    emit: StatusSet
reducers:
  - on: StatusSet
    patches:
      - { op: replace, path: /id,     value: "\${event.payload.id}" }
      - { op: replace, path: /status, value: "\${event.payload.status}" }
`;

// Use mapping targeting the Widget schema — /status is a known path.
const USE_WIDGET_YAML = `
use:
  - component: StatusEntity
    as: Widget
    contract_path: /widgets/{id}
    with:
      operationId: createWidget
`;

// Use mapping targeting the Gadget schema — Gadget has no /status property.
const USE_GADGET_YAML = `
use:
  - component: StatusEntity
    as: Gadget
    contract_path: /gadgets/{id}
    with:
      operationId: createGadget
`;

// ---------------------------------------------------------------------------
// Suite 1 — Phase 1: component compiles cleanly as an inert definition
// ---------------------------------------------------------------------------

describe('C6 Phase 1 — inert component is not subject to binding-dependent checks', () => {
  it('a component with a binding-dependent reducer compiles without error (no contract_path, no OpenAPI check)', async () => {
    await expect(
      compileDsl(
        [],
        undefined,
        [{ name: 'status-entity.yaml', yaml: BINDING_DEPENDENT_COMPONENT_YAML }],
      ),
    ).resolves.toBeDefined();
  });

  it('the compiled output has no live boundaries — the component is inert', async () => {
    const compiled = await compileDsl(
      [],
      undefined,
      [{ name: 'status-entity.yaml', yaml: BINDING_DEPENDENT_COMPONENT_YAML }],
    );

    expect(compiled.boundaries).toHaveLength(0);
    expect(Object.keys(compiled.byBoundaryName)).toHaveLength(0);
  });

  it('the component is stashed in compiled.components and not in boundaries', async () => {
    const compiled = await compileDsl(
      [],
      undefined,
      [{ name: 'status-entity.yaml', yaml: BINDING_DEPENDENT_COMPONENT_YAML }],
    );

    expect(compiled.components).toBeDefined();
    expect(compiled.components!['StatusEntity']).toBeDefined();
    expect(compiled.components!['StatusEntity']!.kind).toBe('component');
    expect(compiled.boundaries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 2a — Phase 3: binding-dependent check passes when path is valid
// ---------------------------------------------------------------------------

describe('C6 Phase 3 — binding-dependent check runs post-link (valid schema path)', () => {
  it('instantiating onto a schema that has the patch path succeeds at boot', async () => {
    const openapi = await loadOpenApi(OPENAPI_YAML);
    const compiled = await compileDsl(
      [],
      undefined,
      [{ name: 'status-entity.yaml', yaml: BINDING_DEPENDENT_COMPONENT_YAML }],
      [{ name: 'use-widget.yaml', yaml: USE_WIDGET_YAML }],
    );

    await expect(bootSystem({ openapi, compiledDsl: compiled })).resolves.toBeDefined();
  });

  it('the linked boundary appears in byBoundaryName before boot validation runs', async () => {
    const compiled = await compileDsl(
      [],
      undefined,
      [{ name: 'status-entity.yaml', yaml: BINDING_DEPENDENT_COMPONENT_YAML }],
      [{ name: 'use-widget.yaml', yaml: USE_WIDGET_YAML }],
    );

    expect(compiled.byBoundaryName['Widget']).toBeDefined();
    expect(compiled.byBoundaryName['Widget']!.contractPath).toBe('/widgets/{id}');
  });
});

// ---------------------------------------------------------------------------
// Suite 2b — Phase 3: binding-dependent check fails when path is invalid
// ---------------------------------------------------------------------------

describe('C6 Phase 3 — binding-dependent check runs post-link (invalid schema path)', () => {
  it('instantiating onto a schema that does NOT have the patch path fails at boot with BOOT_ERR_DSL_SCHEMA_VIOLATION', async () => {
    const openapi = await loadOpenApi(OPENAPI_YAML);
    const compiled = await compileDsl(
      [],
      undefined,
      [{ name: 'status-entity.yaml', yaml: BINDING_DEPENDENT_COMPONENT_YAML }],
      [{ name: 'use-gadget.yaml', yaml: USE_GADGET_YAML }],
    );

    await expect(bootSystem({ openapi, compiledDsl: compiled })).rejects.toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_SCHEMA_VIOLATION' }),
    );
  });

  it('the compile step itself does not throw — the error is deferred to boot Phase 3', async () => {
    await expect(
      compileDsl(
        [],
        undefined,
        [{ name: 'status-entity.yaml', yaml: BINDING_DEPENDENT_COMPONENT_YAML }],
        [{ name: 'use-gadget.yaml', yaml: USE_GADGET_YAML }],
      ),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — Phase 3: invalid cross-reference in linked model still rejected
// ---------------------------------------------------------------------------

describe('C6 Phase 3 — invalid cross-reference in linked model fails with BOOT_ERR_DSL_REFERENCE', () => {
  it('a reaction whose reacting boundary does not exist fails at Phase 3 with BOOT_ERR_DSL_REFERENCE', async () => {
    // Two boundaries: Sender emits OrderPlaced; OrderRelay reacts to it but
    // its "boundary" field names a nonexistent boundary ("GhostBoundary").
    // This is caught by validateReactionCrossReferences AFTER linkComponents.
    const senderYaml = `
boundary: Sender
contract_path: /widgets/{id}
event_catalog:
  - type: OrderPlaced
    payload_template:
      id: "command.targetId"
behaviors:
  - name: place-order
    match:
      operationId: createWidget
      condition: "true"
    emit: OrderPlaced
reducers:
  - on: OrderPlaced
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
`;

    const badReactionGlobalYaml = `
reactions:
  - name: ghost-reaction
    on: OrderPlaced
    boundary: GhostBoundary
    emit: OrderPlaced
`;

    await expect(
      compileDsl(
        [{ name: 'sender.yaml', yaml: senderYaml }],
        badReactionGlobalYaml,
      ),
    ).rejects.toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_REFERENCE' }),
    );
  });

  it('a reaction with a valid cross-reference in the linked model succeeds at compile and boot', async () => {
    // Two file boundaries, reaction wired between them — all valid.
    const boundaryAYaml = `
boundary: Widget
contract_path: /widgets/{id}
event_catalog:
  - type: WidgetMade
    payload_template:
      id: "command.targetId"
      status: "'ACTIVE'"
behaviors:
  - name: make-widget
    match:
      operationId: createWidget
      condition: "true"
    emit: WidgetMade
reducers:
  - on: WidgetMade
    patches:
      - { op: replace, path: /id,     value: "\${event.payload.id}" }
      - { op: replace, path: /status, value: "\${event.payload.status}" }
reactions:
  - name: echo-widget-made
    on: WidgetMade
    emit: WidgetMade
`;

    const openapi = await loadOpenApi(OPENAPI_YAML);
    const compiled = await compileDsl(
      [{ name: 'widget.yaml', yaml: boundaryAYaml }],
    );

    await expect(bootSystem({ openapi, compiledDsl: compiled })).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — Non-composed fixture smoke test (proves Phase 3 unchanged)
// ---------------------------------------------------------------------------

describe('C6 non-composed fixture — Phase 3 contract-binding unchanged', () => {
  it('a plain boundary file boots cleanly with no composition involved', async () => {
    const simpleYaml = `
boundary: Widget
contract_path: /widgets/{id}
event_catalog:
  - type: WidgetCreated
    payload_template:
      id: "command.targetId"
      status: "'NEW'"
behaviors:
  - name: create-widget
    match:
      operationId: createWidget
      condition: "true"
    emit: WidgetCreated
reducers:
  - on: WidgetCreated
    patches:
      - { op: replace, path: /id,     value: "\${event.payload.id}" }
      - { op: replace, path: /status, value: "\${event.payload.status}" }
`;

    const openapi = await loadOpenApi(OPENAPI_YAML);
    const compiled = await compileDsl([{ name: 'widget.yaml', yaml: simpleYaml }]);

    const sys = await bootSystem({ openapi, compiledDsl: compiled });
    expect(sys.dsl.boundaries).toHaveLength(1);
    expect(sys.dsl.byBoundaryName['Widget']).toBeDefined();
  });

  it('a plain boundary with an unknown contract_path still fails at boot Phase 3 with BOOT_ERR_DSL_REFERENCE', async () => {
    const badYaml = `
boundary: NoSuchPath
contract_path: /nonexistent
behaviors: []
reducers: []
event_catalog: []
`;

    const openapi = await loadOpenApi(OPENAPI_YAML);
    const compiled = await compileDsl([{ name: 'bad.yaml', yaml: badYaml }]);

    await expect(bootSystem({ openapi, compiledDsl: compiled })).rejects.toThrow(
      expect.objectContaining({ code: 'BOOT_ERR_DSL_REFERENCE' }),
    );
  });
});
