/**
 * Coverage backfill for engine/uow.ts
 *
 * Uncovered lines:
 *  - 153-170: shadowAsStateGraph.values / .entries / .purge / .size (recursive paths)
 *  - 330: InternalExecutionError for unknown boundary in pendingCommands
 *  - 411: InternalExecutionError when query intent + openapi not provided
 *  - 417: InternalExecutionError when query intent + unknown boundary name in dsl
 */

import { executeUnitOfWork } from '../../../src/engine/uow';
import {
  InternalExecutionError,
} from '../../../src/errors';
import { bootSystem, type BootedSystem } from '../../../src/engine/boot';
import { resetSystem } from '../../../src/engine/reset';
import { loadOpenApi } from '../../../src/contract/loader';
import { nextUuidv7 } from '../../../src/ids/uuidv7';
import { compileDsl } from '../../../src/dsl/parser';

// ── minimal fixture ──────────────────────────────────────────────────────────

const SIMPLE_OPENAPI = `
openapi: "3.0.3"
info:
  title: UoW Coverage Test
  version: "1.0.0"
paths:
  /items:
    get:
      operationId: listItems
      responses:
        "200":
          description: Items
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/Item"
    post:
      operationId: createItem
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Item"
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Item"
  /items/{id}:
    get:
      operationId: getItem
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: Item
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ItemById"
        "404":
          description: Not found
          content:
            application/json:
              schema:
                type: object
components:
  schemas:
    Item:
      type: object
      properties:
        id:
          type: string
        label:
          type: string
      required:
        - id
        - label
    ItemById:
      type: object
      properties:
        id:
          type: string
        label:
          type: string
      required:
        - id
        - label
`;

const ITEM_DSL = `
boundary: Item
contract_path: /items
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: ItemCreated
    payload_template:
      id: "command.targetId"
      label: "command.payload.label"
behaviors:
  - name: create-item
    match:
      operationId: createItem
      condition: "true"
    emit: ItemCreated
reducers:
  - on: ItemCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /label, value: "\${event.payload.label}" }
`;

const ITEM_BY_ID_DSL = `
boundary: ItemById
contract_path: /items/{id}
fallback_override: true
event_catalog: []
behaviors: []
reducers: []
`;

let sys: BootedSystem;

beforeEach(async () => {
  const openapi = await loadOpenApi(SIMPLE_OPENAPI);
  sys = await bootSystem({
    openapi,
    compiledDsl: await compileDsl([
      { name: 'item', yaml: ITEM_DSL },
      { name: 'itemById', yaml: ITEM_BY_ID_DSL },
    ]),
  });
});

afterEach(() => {
  resetSystem(sys);
});

async function createItem(label = 'test-label'): Promise<string> {
  const itemId = nextUuidv7();
  await executeUnitOfWork({
    command: {
      commandId: nextUuidv7(),
      boundary: 'Item',
      intent: 'creation',
      targetId: itemId,
      payload: { label },
      queryParams: {},
      httpMethod: 'POST',
      path: '/items',
      origin: 'inbound',
      depth: 0,
    },
    dsl: sys.dsl,
    openapi: sys.openapi,
    graph: sys.graph,
    events: sys.events,
    cel: sys.cel,
    validator: sys.validator,
    schemaRegistry: sys.schemaRegistry,
  });
  return itemId;
}

describe('engine/uow — additional coverage', () => {

  // ── shadowAsStateGraph — keys/values/entries exercised via collection query ──

  it('collection query via ItemById (fallback_override) exercises shadowAsStateGraph.keys', async () => {
    // Create an item first so the graph has content
    const itemId = await createItem('shadow-test');

    // A query via ItemById (fallback_override: true) goes through runPatternMatch with
    // the shadow adapter, which calls shadowAsStateGraph.keys() → values() → entries()
    const result = await executeUnitOfWork({
      command: {
        commandId: nextUuidv7(),
        boundary: 'ItemById',
        intent: 'query',
        targetId: itemId,
        payload: {},
        queryParams: {},
        httpMethod: 'GET',
        path: `/items/${itemId}`,
        origin: 'inbound',
        depth: 0,
      },
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
      openapi: sys.openapi,
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ id: itemId, label: 'shadow-test' });
  });

  it('faultSignal with headers returns the headers (line 153)', async () => {
    const faultSignal = JSON.stringify({
      status: 503,
      body: { error: 'DOWN' },
      headers: { 'Retry-After': '30', 'X-Fault': 'simulated' },
    });

    const result = await executeUnitOfWork({
      command: {
        commandId: nextUuidv7(),
        boundary: 'Item',
        intent: 'creation',
        targetId: null,
        payload: {},
        queryParams: {},
        httpMethod: 'POST',
        path: '/items',
        origin: 'inbound',
        depth: 0,
        faultSignal,
      },
      dsl: sys.dsl,
      openapi: sys.openapi,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
    });

    expect(result.status).toBe(503);
    expect(result.headers?.['Retry-After']).toBe('30');
    expect(result.headers?.['X-Fault']).toBe('simulated');
  });

  // ── Line 330: unknown boundary in secondary command cascade ─────────────────

  it('throws InternalExecutionError when a secondary command targets unknown boundary (line 330)', async () => {
    // Build a DSL with a dispatch_commands referencing a boundary that does NOT exist
    const openapi = await loadOpenApi(SIMPLE_OPENAPI);
    const dslWithBadDispatch = `
boundary: Item
contract_path: /items
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: ItemCreated
    payload_template:
      id: "command.targetId"
      label: "command.payload.label"
behaviors:
  - name: create-item
    match:
      operationId: createItem
      condition: "true"
    emit: ItemCreated
    dispatch_commands:
      - boundary: NonExistentBoundary
        intent: mutation
        operationId: getItem
        target_id: "command.targetId"
        payload: {}
reducers:
  - on: ItemCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /label, value: "\${event.payload.label}" }
`;

    // bootSystem succeeds — the bad dispatch target is only detected at runtime
    const badSys = await bootSystem({
      openapi,
      compiledDsl: await compileDsl([
        { name: 'item', yaml: dslWithBadDispatch },
        { name: 'itemById', yaml: ITEM_BY_ID_DSL },
      ]),
    });

    const itemId = nextUuidv7();
    await expect(
      executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'Item',
          intent: 'creation',
          targetId: itemId,
          payload: { label: 'bad-dispatch' },
          queryParams: {},
          httpMethod: 'POST',
          path: '/items',
          origin: 'inbound',
          depth: 0,
        },
        dsl: badSys.dsl,
        graph: badSys.graph,
        events: badSys.events,
        cel: badSys.cel,
        validator: badSys.validator,
        schemaRegistry: badSys.schemaRegistry,
      }),
    ).rejects.toBeInstanceOf(InternalExecutionError);

    resetSystem(badSys);
  });

  // ── Line 411: query intent without openapi document ─────────────────────────

  it('throws InternalExecutionError when query intent is missing openapi (line 411)', async () => {
    const itemId = await createItem('query-no-openapi');

    await expect(
      executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'ItemById',
          intent: 'query',
          targetId: itemId,
          payload: {},
          queryParams: {},
          httpMethod: 'GET',
          path: `/items/${itemId}`,
          origin: 'inbound',
          depth: 0,
        },
        dsl: sys.dsl,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        schemaRegistry: sys.schemaRegistry,
        // openapi deliberately omitted → InternalExecutionError
      }),
    ).rejects.toBeInstanceOf(InternalExecutionError);
  });

  it('InternalExecutionError for missing openapi has descriptive message (line 411)', async () => {
    const itemId = await createItem('q2');
    try {
      await executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'ItemById',
          intent: 'query',
          targetId: itemId,
          payload: {},
          queryParams: {},
          httpMethod: 'GET',
          path: `/items/${itemId}`,
          origin: 'inbound',
          depth: 0,
        },
        dsl: sys.dsl,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        schemaRegistry: sys.schemaRegistry,
      });
      fail('expected error');
    } catch (err) {
      expect((err as InternalExecutionError).message).toMatch(/openapi/i);
    }
  });

  // ── Line 417: query intent with unknown boundary name in dsl ─────────────────

  it('throws InternalExecutionError when query boundary is unknown in dsl (line 417)', async () => {
    const itemId = await createItem('q3');

    // Mutate dsl to have an incomplete byBoundaryName map so the boundary is missing
    const tamperedDsl = {
      ...sys.dsl,
      byBoundaryName: {
        // Remove 'ItemById' so the query boundary lookup fails
        Item: sys.dsl.byBoundaryName['Item']!,
      },
    };

    await expect(
      executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'ItemById',
          intent: 'query',
          targetId: itemId,
          payload: {},
          queryParams: {},
          httpMethod: 'GET',
          path: `/items/${itemId}`,
          origin: 'inbound',
          depth: 0,
        },
        dsl: tamperedDsl as typeof sys.dsl,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        schemaRegistry: sys.schemaRegistry,
        openapi: sys.openapi,
      }),
    ).rejects.toBeInstanceOf(InternalExecutionError);
  });
});
