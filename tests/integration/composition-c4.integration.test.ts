/**
 * Integration tests for C4: fragment inclusion (include:) merge.
 *
 * Acceptance criteria (potemkin-rcuc):
 *  1. A boundary that includes an AuditMixin gains the mixin's event types and
 *     reducers; an event defined only in the mixin projects correctly on the
 *     host boundary's state (via executeUnitOfWork).
 *  2. A local declaration overrides an included one on the same key — the local
 *     version wins in the compiled boundary.
 *  3. Two included fragments clashing on the same event type / reducer on throw
 *     BOOT_ERR_DSL_SYNTAX.
 *  4. Unknown included component throws BOOT_ERR_DSL_REFERENCE.
 *  5. Existing non-composed fixtures (no include:) compile cleanly.
 */

import { bootSystem } from '../../src/engine/boot.js';
import { executeUnitOfWork } from '../../src/engine/uow.js';
import { resetSystem } from '../../src/engine/reset.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import type { Command } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Shared OpenAPI spec
// ---------------------------------------------------------------------------

const OPENAPI_YAML = `
openapi: "3.0.3"
info:
  title: C4 Composition Test
  version: "1.0.0"
paths:
  /documents/{id}:
    post:
      operationId: createDocument
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: false
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Document" }
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Document" }
    get:
      operationId: getDocument
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
              schema: { $ref: "#/components/schemas/Document" }
    patch:
      operationId: auditDocument
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: false
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Document" }
      responses:
        "200":
          description: Audited
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Document" }
  /docs-no-include/{id}:
    post:
      operationId: createDocNoInclude
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: false
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Document" }
      responses:
        "201":
          description: Created
  /use-audited-docs/{id}:
    post:
      operationId: createAuditedDoc
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: false
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Document" }
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Document" }
    patch:
      operationId: auditAuditedDoc
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: false
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Document" }
      responses:
        "200":
          description: Audited
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Document" }
    get:
      operationId: getAuditedDoc
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
              schema: { $ref: "#/components/schemas/Document" }
components:
  schemas:
    Document:
      type: object
      properties:
        id:         { type: string }
        status:     { type: string }
        lastActor:  { type: string }
      required: [id, status]
    AuditedDocument:
      type: object
      properties:
        id:         { type: string }
        status:     { type: string }
        lastActor:  { type: string }
      required: [id, status]
`;

// ---------------------------------------------------------------------------
// DSL fixtures
// ---------------------------------------------------------------------------

const AUDIT_MIXIN_YAML = `
kind: component
name: AuditMixin
parameters:
  actorField:
    type: string
    default: "lastActor"
event_catalog:
  - type: AuditLogged
    payload_template:
      actor: "'system'"
reducers:
  - on: AuditLogged
    patches:
      - op: replace
        path: "/{{actorField}}"
        value: "\${event.payload.actor}"
`;

// Host boundary that includes AuditMixin — plus its own event/reducer.
// AuditLogged is declared locally so the behavior validator passes; the local entry
// wins over the mixin's, but the mixin's reducer is still merged (no local reducer for it).
const DOCUMENT_WITH_MIXIN_YAML = `
boundary: Document
contract_path: /documents/{id}
include:
  - component: AuditMixin
    with:
      actorField: "lastActor"
event_catalog:
  - type: DocumentCreated
    payload_template:
      id: "command.targetId"
      status: "'DRAFT'"
  - type: AuditLogged
    payload_template:
      actor: "'audit-user'"
behaviors:
  - name: create-document
    match:
      operationId: createDocument
      condition: "true"
    emit: DocumentCreated
  - name: log-audit
    match:
      operationId: auditDocument
      condition: "true"
    emit: AuditLogged
reducers:
  - on: DocumentCreated
    patches:
      - { op: replace, path: /id,     value: "\${event.payload.id}" }
      - { op: replace, path: /status, value: "\${event.payload.status}" }
`;

// Component with a built-in include: AuditMixin — for testing component-carried includes via use:.
// The component declares AuditLogged in its own catalog (required for behavior emit validation),
// but does NOT declare a reducer for it. The mixin's reducer for AuditLogged is therefore merged
// in and proves the component-carried include path is functional.
const AUDITED_DOC_COMPONENT_YAML = `
kind: component
name: AuditedDoc
parameters:
  createOp:
    type: string
    required: true
  auditOp:
    type: string
    required: true
include:
  - component: AuditMixin
    with:
      actorField: "lastActor"
event_catalog:
  - type: DocCreated
    payload_template:
      id: "command.targetId"
      status: "'ACTIVE'"
  - type: AuditLogged
    payload_template:
      actor: "'mixin-test'"
behaviors:
  - name: create-doc
    match:
      operationId: "{{createOp}}"
      condition: "true"
    emit: DocCreated
  - name: log-audit
    match:
      operationId: "{{auditOp}}"
      condition: "true"
    emit: AuditLogged
reducers:
  - on: DocCreated
    patches:
      - { op: replace, path: /id,     value: "\${event.payload.id}" }
      - { op: replace, path: /status, value: "\${event.payload.status}" }
`;

const USE_AUDITED_DOC_YAML = `
use:
  - component: AuditedDoc
    as: AuditedDocument
    contract_path: /use-audited-docs/{id}
    with:
      createOp: createAuditedDoc
      auditOp: auditAuditedDoc
`;

// Host boundary that locally declares AuditLogged (override scenario).
const DOCUMENT_WITH_LOCAL_OVERRIDE_YAML = `
boundary: Document
contract_path: /documents/{id}
include:
  - component: AuditMixin
event_catalog:
  - type: AuditLogged
    payload_template:
      actor: "'local-override'"
  - type: DocumentCreated
    payload_template:
      id: "command.targetId"
      status: "'DRAFT'"
behaviors:
  - name: create-document
    match:
      operationId: createDocument
      condition: "true"
    emit: DocumentCreated
reducers:
  - on: DocumentCreated
    patches:
      - { op: replace, path: /id,     value: "\${event.payload.id}" }
      - { op: replace, path: /status, value: "\${event.payload.status}" }
  - on: AuditLogged
    patches:
      - { op: replace, path: /lastActor, value: "'local-wins'" }
`;

// Simple boundary with no include: — used to verify no regression.
const NO_INCLUDE_YAML = `
boundary: NoInclude
contract_path: /docs-no-include/{id}
event_catalog:
  - type: DocNoIncludeCreated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: create
    match:
      operationId: createDocNoInclude
      condition: "true"
    emit: DocNoIncludeCreated
reducers:
  - on: DocNoIncludeCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
`;

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeCommand(boundary: string, path: string, operationId: string, id: string): Command {
  return {
    commandId: nextUuidv7(),
    boundary,
    intent: 'creation',
    targetId: id,
    payload: {},
    queryParams: {},
    httpMethod: 'POST',
    path,
    origin: 'inbound',
    depth: 0,
  };
}

function makeMutationCommand(boundary: string, path: string, operationId: string, id: string): Command {
  return {
    commandId: nextUuidv7(),
    boundary,
    intent: 'mutation',
    targetId: id,
    payload: {},
    queryParams: {},
    httpMethod: 'PATCH',
    path,
    origin: 'inbound',
    depth: 0,
  };
}

// ---------------------------------------------------------------------------
// Suite 1: Boundary with AuditMixin — mixin event + reducer are functional
// ---------------------------------------------------------------------------

describe('C4 — boundary including AuditMixin gains mixin event and reducer', () => {
  it('compiled boundary eventCatalog contains both DocumentCreated and AuditLogged', async () => {
    const dsl = await compileDsl(
      [{ name: 'document.yaml', yaml: DOCUMENT_WITH_MIXIN_YAML }],
      undefined,
      [{ name: 'audit-mixin.yaml', yaml: AUDIT_MIXIN_YAML }],
    );

    const boundary = dsl.byBoundaryName['Document']!;
    const types = boundary.eventCatalog.map((e) => e.type);
    expect(types).toContain('DocumentCreated');
    expect(types).toContain('AuditLogged');
  });

  it('compiled boundary reducers contain both DocumentCreated and AuditLogged handlers', async () => {
    const dsl = await compileDsl(
      [{ name: 'document.yaml', yaml: DOCUMENT_WITH_MIXIN_YAML }],
      undefined,
      [{ name: 'audit-mixin.yaml', yaml: AUDIT_MIXIN_YAML }],
    );

    const boundary = dsl.byBoundaryName['Document']!;
    const ons = boundary.reducers.map((r) => r.on);
    expect(ons).toContain('DocumentCreated');
    expect(ons).toContain('AuditLogged');
  });

  it('host DocumentCreated reducer projects onto the host boundary state', async () => {
    const openapi = await loadOpenApi(OPENAPI_YAML);
    const dsl = await compileDsl(
      [{ name: 'document.yaml', yaml: DOCUMENT_WITH_MIXIN_YAML }],
      undefined,
      [{ name: 'audit-mixin.yaml', yaml: AUDIT_MIXIN_YAML }],
    );
    const sys = await bootSystem({ openapi, compiledDsl: dsl });

    try {
      const id = nextUuidv7();
      const cmd = makeCommand('Document', `/documents/${id}`, 'createDocument', id);
      await executeUnitOfWork({
        command: cmd,
        dsl: sys.dsl,
        openapi: sys.openapi,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
      });

      const state = sys.graph.get(id);
      expect(state!['status']).toBe('DRAFT');
    } finally {
      resetSystem(sys);
    }
  });

  it('mixin-only AuditLogged event projects lastActor onto host boundary state (AC1 end-to-end)', async () => {
    // This test proves AC1: emit an event defined ONLY in the mixin (AuditLogged),
    // then assert the MIXIN reducer ran and set /lastActor on the host boundary state.
    const openapi = await loadOpenApi(OPENAPI_YAML);
    const dsl = await compileDsl(
      [{ name: 'document.yaml', yaml: DOCUMENT_WITH_MIXIN_YAML }],
      undefined,
      [{ name: 'audit-mixin.yaml', yaml: AUDIT_MIXIN_YAML }],
    );
    const sys = await bootSystem({ openapi, compiledDsl: dsl });

    try {
      const id = nextUuidv7();

      // First create the aggregate so a mutation can target it.
      const createCmd = makeCommand('Document', `/documents/${id}`, 'createDocument', id);
      await executeUnitOfWork({
        command: createCmd,
        dsl: sys.dsl,
        openapi: sys.openapi,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
      });

      // Now emit the MIXIN-ONLY event (AuditLogged) via the log-audit behavior.
      const auditCmd = makeMutationCommand('Document', `/documents/${id}`, 'auditDocument', id);
      await executeUnitOfWork({
        command: auditCmd,
        dsl: sys.dsl,
        openapi: sys.openapi,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
      });

      const state = sys.graph.get(id);
      // The boundary declares AuditLogged with actor: "'audit-user'" (local wins over mixin payload).
      // The mixin's reducer (merged since no local reducer for AuditLogged) sets /lastActor = 'audit-user'.
      expect(state!['lastActor']).toBe('audit-user');
    } finally {
      resetSystem(sys);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Local declaration overrides included one on the same key
// ---------------------------------------------------------------------------

describe('C4 — local declaration wins over included entry on key clash', () => {
  it('only one AuditLogged entry in event catalog (local version)', async () => {
    const dsl = await compileDsl(
      [{ name: 'document.yaml', yaml: DOCUMENT_WITH_LOCAL_OVERRIDE_YAML }],
      undefined,
      [{ name: 'audit-mixin.yaml', yaml: AUDIT_MIXIN_YAML }],
    );

    const boundary = dsl.byBoundaryName['Document']!;
    const matching = boundary.eventCatalog.filter((e) => e.type === 'AuditLogged');
    expect(matching).toHaveLength(1);
    // The local event payload should carry 'local-override', not the mixin's.
    expect(matching[0]!.payloadTemplate['actor']).toBe("'local-override'");
  });

  it('only one AuditLogged reducer (local version)', async () => {
    const dsl = await compileDsl(
      [{ name: 'document.yaml', yaml: DOCUMENT_WITH_LOCAL_OVERRIDE_YAML }],
      undefined,
      [{ name: 'audit-mixin.yaml', yaml: AUDIT_MIXIN_YAML }],
    );

    const boundary = dsl.byBoundaryName['Document']!;
    const matching = boundary.reducers.filter((r) => r.on === 'AuditLogged');
    expect(matching).toHaveLength(1);
    // Local reducer patches /lastActor to 'local-wins', not the mixin's actor path.
    expect(matching[0]!.patches![0]!.value).toBe("'local-wins'");
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Fragment inclusion clash rules
//  - event type clash → BOOT_ERR_DSL_SYNTAX (unique key)
//  - behavior name clash → BOOT_ERR_DSL_SYNTAX (unique key)
//  - reducer on clash → COEXIST (non-unique key; engine runs all matching reducers)
// ---------------------------------------------------------------------------

describe('C4 — fragment inclusion clash rules', () => {
  const MIXIN_A_EVENT_YAML = `
kind: component
name: MixinA
event_catalog:
  - type: ClashingEvent
    payload_template: {}
reducers: []
behaviors: []
`;

  const MIXIN_B_EVENT_YAML = `
kind: component
name: MixinB
event_catalog:
  - type: ClashingEvent
    payload_template: {}
reducers: []
behaviors: []
`;

  const BOUNDARY_WITH_EVENT_CLASH_YAML = `
boundary: Document
contract_path: /documents/{id}
include:
  - component: MixinA
  - component: MixinB
event_catalog: []
behaviors: []
reducers: []
`;

  it('throws BOOT_ERR_DSL_SYNTAX when two included components provide the same event type', async () => {
    await expect(
      compileDsl(
        [{ name: 'document.yaml', yaml: BOUNDARY_WITH_EVENT_CLASH_YAML }],
        undefined,
        [
          { name: 'mixin-a.yaml', yaml: MIXIN_A_EVENT_YAML },
          { name: 'mixin-b.yaml', yaml: MIXIN_B_EVENT_YAML },
        ],
      ),
    ).rejects.toThrow(expect.objectContaining({ code: 'BOOT_ERR_DSL_SYNTAX' }));
  });

  it('throws BOOT_ERR_DSL_SYNTAX when two included components provide the same behavior name', async () => {
    const MIXIN_A_BEH_YAML = `
kind: component
name: MixinA
event_catalog:
  - type: MixinADone
    payload_template: {}
reducers: []
behaviors:
  - name: shared-behavior
    match:
      operationId: doSomething
      condition: "true"
    emit: MixinADone
`;
    const MIXIN_B_BEH_YAML = `
kind: component
name: MixinB
event_catalog:
  - type: MixinBDone
    payload_template: {}
reducers: []
behaviors:
  - name: shared-behavior
    match:
      operationId: doSomethingElse
      condition: "true"
    emit: MixinBDone
`;
    const BOUNDARY_WITH_BEH_CLASH_YAML = `
boundary: Document
contract_path: /documents/{id}
include:
  - component: MixinA
  - component: MixinB
event_catalog: []
behaviors: []
reducers: []
`;
    await expect(
      compileDsl(
        [{ name: 'document.yaml', yaml: BOUNDARY_WITH_BEH_CLASH_YAML }],
        undefined,
        [
          { name: 'mixin-a.yaml', yaml: MIXIN_A_BEH_YAML },
          { name: 'mixin-b.yaml', yaml: MIXIN_B_BEH_YAML },
        ],
      ),
    ).rejects.toThrow(expect.objectContaining({ code: 'BOOT_ERR_DSL_SYNTAX' }));
  });

  it('two included components with the same reducer on coexist (both present in merged boundary)', async () => {
    // Reducer `on` is a non-unique key: the engine runs ALL reducers matching an event type.
    // The host locally declares SharedEvent (suppresses mixin event entries so no event-type
    // clash occurs), but provides no local reducer for it, so both mixin reducers are merged in.
    const MIXIN_A_RED_YAML = `
kind: component
name: MixinA
event_catalog:
  - type: SharedEvent
    payload_template: {}
reducers:
  - on: SharedEvent
    patches:
      - { op: replace, path: /fieldA, value: "'fromA'" }
behaviors: []
`;
    const MIXIN_B_RED_YAML = `
kind: component
name: MixinB
event_catalog:
  - type: SharedEvent
    payload_template: {}
reducers:
  - on: SharedEvent
    patches:
      - { op: replace, path: /fieldB, value: "'fromB'" }
behaviors: []
`;
    // Host declares SharedEvent locally so the event-type clash is suppressed (local wins).
    // Host has NO local reducer for SharedEvent, so both mixin reducers are appended.
    const BOUNDARY_WITH_RED_COEXIST_YAML = `
boundary: Document
contract_path: /documents/{id}
include:
  - component: MixinA
  - component: MixinB
event_catalog:
  - type: SharedEvent
    payload_template: {}
behaviors: []
reducers: []
`;

    const dsl = await compileDsl(
      [{ name: 'document.yaml', yaml: BOUNDARY_WITH_RED_COEXIST_YAML }],
      undefined,
      [
        { name: 'mixin-a.yaml', yaml: MIXIN_A_RED_YAML },
        { name: 'mixin-b.yaml', yaml: MIXIN_B_RED_YAML },
      ],
    );

    const boundary = dsl.byBoundaryName['Document']!;
    const matching = boundary.reducers.filter((r) => r.on === 'SharedEvent');
    // Both reducers must coexist in the merged boundary.
    expect(matching).toHaveLength(2);
    const paths = matching.map((r) => r.patches![0]!.path);
    expect(paths).toContain('/fieldA');
    expect(paths).toContain('/fieldB');
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Unknown included component throws BOOT_ERR_DSL_REFERENCE
// ---------------------------------------------------------------------------

describe('C4 — unknown included component throws BOOT_ERR_DSL_REFERENCE', () => {
  const BOUNDARY_WITH_UNKNOWN_INCLUDE_YAML = `
boundary: Document
contract_path: /documents/{id}
include:
  - component: NonExistentMixin
event_catalog: []
behaviors: []
reducers: []
`;

  it('throws BOOT_ERR_DSL_REFERENCE when the included component does not exist', async () => {
    await expect(
      compileDsl(
        [{ name: 'document.yaml', yaml: BOUNDARY_WITH_UNKNOWN_INCLUDE_YAML }],
        undefined,
        [],
      ),
    ).rejects.toThrow(expect.objectContaining({ code: 'BOOT_ERR_DSL_REFERENCE' }));
  });
});

// ---------------------------------------------------------------------------
// Suite 5: Non-composed fixtures are unaffected by the merge pass
// ---------------------------------------------------------------------------

describe('C4 — existing boundaries without include: are unaffected', () => {
  it('compiles a boundary without include: to the same event types it had before', async () => {
    const dsl = await compileDsl(
      [{ name: 'no-include.yaml', yaml: NO_INCLUDE_YAML }],
    );

    const boundary = dsl.byBoundaryName['NoInclude']!;
    expect(boundary.eventCatalog).toHaveLength(1);
    expect(boundary.eventCatalog[0]!.type).toBe('DocNoIncludeCreated');
    expect(boundary.reducers).toHaveLength(1);
    expect(boundary.behaviors).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Suite 6 (Defect 2): component-carried include: is propagated through use:
// A component that declares include: and is instantiated via use: must have
// its fragments merged by the subsequent mergeIncludes pass.
// ---------------------------------------------------------------------------

describe('C4 — component-carried include: propagated through use: instantiation', () => {
  it('compiled use:-instantiated boundary gains AuditMixin reducer from component-declared include:', async () => {
    // The component declares AuditLogged locally (so its behavior can emit it), but provides
    // NO reducer for it. The mixin contributes the reducer. After use: instantiation + C4 merge,
    // the boundary must have the mixin's AuditLogged reducer.
    const dsl = await compileDsl(
      [],
      undefined,
      [
        { name: 'audit-mixin.yaml', yaml: AUDIT_MIXIN_YAML },
        { name: 'audited-doc.yaml', yaml: AUDITED_DOC_COMPONENT_YAML },
      ],
      [{ name: 'use-mapping.yaml', yaml: USE_AUDITED_DOC_YAML }],
    );

    const boundary = dsl.byBoundaryName['AuditedDocument']!;
    expect(boundary).toBeDefined();

    const types = boundary.eventCatalog.map((e) => e.type);
    expect(types).toContain('DocCreated');
    expect(types).toContain('AuditLogged');

    // The mixin's reducer for AuditLogged was merged in (component has no local AuditLogged reducer).
    const ons = boundary.reducers.map((r) => r.on);
    expect(ons).toContain('DocCreated');
    expect(ons).toContain('AuditLogged');
  });

  it('mixin reducer from component-carried include: projects lastActor onto use:-instantiated boundary state', async () => {
    // Prove end-to-end: the mixin's reducer (merged via component-declared include:) projects
    // onto state when AuditLogged is emitted on the use:-instantiated boundary.
    // AuditLogged is declared by the component (actor: "'mixin-test'"), no local reducer exists,
    // so the mixin's reducer runs: sets /lastActor = event.payload.actor = 'mixin-test'.
    const openapi = await loadOpenApi(OPENAPI_YAML);
    const dsl = await compileDsl(
      [],
      undefined,
      [
        { name: 'audit-mixin.yaml', yaml: AUDIT_MIXIN_YAML },
        { name: 'audited-doc.yaml', yaml: AUDITED_DOC_COMPONENT_YAML },
      ],
      [{ name: 'use-mapping.yaml', yaml: USE_AUDITED_DOC_YAML }],
    );
    const sys = await bootSystem({ openapi, compiledDsl: dsl });

    try {
      const id = nextUuidv7();

      // Create the aggregate first.
      const createCmd = makeCommand('AuditedDocument', `/use-audited-docs/${id}`, 'createAuditedDoc', id);
      await executeUnitOfWork({
        command: createCmd,
        dsl: sys.dsl,
        openapi: sys.openapi,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
      });

      // Emit AuditLogged via the log-audit behavior on the instantiated boundary.
      const auditCmd = makeMutationCommand('AuditedDocument', `/use-audited-docs/${id}`, 'auditAuditedDoc', id);
      await executeUnitOfWork({
        command: auditCmd,
        dsl: sys.dsl,
        openapi: sys.openapi,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
      });

      const state = sys.graph.get(id);
      // Component's AuditLogged payload has actor: "'mixin-test'".
      // Mixin reducer sets /lastActor = ${event.payload.actor} = 'mixin-test'.
      expect(state!['lastActor']).toBe('mixin-test');
    } finally {
      resetSystem(sys);
    }
  });
});
