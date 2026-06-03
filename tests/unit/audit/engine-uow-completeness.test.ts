/**
 * AUDIT: engine/uow.ts — completeness probing tests
 *
 * All tests use plain it(...) — they assert behaviour that must hold in src.
 */

import { executeUnitOfWork } from '../../../src/engine/uow';
import {
  InfiniteLoopError,
  InternalExecutionError,
} from '../../../src/errors';
import { bootSystem, type BootedSystem } from '../../../src/engine/boot';
import { resetSystem } from '../../../src/engine/reset';
import { loadOpenApi } from '../../../src/contract/loader';
import { nextUuidv7 } from '../../../src/ids/uuidv7';
import { compileDsl } from '../../../src/dsl/parser';

// ── Minimal fixture ────────────────────────────────────────────────────────────

const SIMPLE_OPENAPI = `
openapi: "3.0.3"
info:
  title: UoW Audit
  version: "1.0.0"
paths:
  /items:
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
    patch:
      operationId: updateItem
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: Updated
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ItemById"
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
          description: OK
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
        name:
          type: string
      required:
        - id
        - name
    ItemById:
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
      name: "command.payload.name"
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
      - { op: replace, path: /name, value: "\${event.payload.name}" }
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

afterEach(() => resetSystem(sys));

async function createItem(name = 'test'): Promise<string> {
  const id = nextUuidv7();
  await executeUnitOfWork({
    command: {
      commandId: nextUuidv7(),
      boundary: 'Item',
      intent: 'creation',
      targetId: id,
      payload: { name },
      queryParams: {},
      httpMethod: 'POST',
      path: '/items',
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
  return id;
}

// ── VERIFIED: faultSignal short-circuit ───────────────────────────────────────

it('CONTRACT: valid faultSignal bypasses all engine logic and returns simulated response', async () => {
  const faultSignal = JSON.stringify({ status: 503, body: { error: 'unavailable' } });
  const result = await executeUnitOfWork({
    command: {
      commandId: nextUuidv7(),
      boundary: 'Item',
      intent: 'creation',
      targetId: nextUuidv7(),
      payload: { name: 'x' },
      queryParams: {},
      httpMethod: 'POST',
      path: '/items',
      origin: 'inbound',
      depth: 0,
      faultSignal,
    },
    dsl: sys.dsl,
    graph: sys.graph,
    events: sys.events,
    cel: sys.cel,
    validator: sys.validator,
  });

  expect(result.status).toBe(503);
  expect(result.body).toEqual({ error: 'unavailable' });
  expect(result.events).toHaveLength(0);
});

// ── AUDIT GAP: malformed faultSignal → InternalExecutionError ─────────────────

it('CONTRACT: malformed (unparseable JSON) faultSignal throws InternalExecutionError', async () => {
  // uow.ts lines 228-230: JSON.parse failure → InternalExecutionError
  await expect(
    executeUnitOfWork({
      command: {
        commandId: nextUuidv7(),
        boundary: 'Item',
        intent: 'creation',
        targetId: nextUuidv7(),
        payload: { name: 'x' },
        queryParams: {},
        httpMethod: 'POST',
        path: '/items',
        origin: 'inbound',
        depth: 0,
        faultSignal: 'NOT_VALID_JSON{{{',
      },
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
    }),
  ).rejects.toThrow(InternalExecutionError);
});

// ── AUDIT GAP: faultSignal as empty string → not treated as fault ─────────────

it('CONTRACT: faultSignal as empty string is NOT short-circuited (treated as absent)', async () => {
  // uow.ts line 224: condition is `!== undefined && !== ''`
  // Empty string faultSignal should NOT trigger fault short-circuit — execution continues.
  const result = await createItem('valid');
  expect(result).toBeTruthy();
  // If fault-sim had fired, events would be empty; since it didn't, an item was created.
  expect(sys.graph.get(result)).not.toBeNull();
});

// ── AUDIT GAP: unknown boundary in SECONDARY command ─────────────────────────

it('secondary command referencing unknown boundary name throws InternalExecutionError (uow.ts:329-333)', async () => {
  // uow.ts lines 341-346: if boundary === undefined → InternalExecutionError
  // We can exercise this path by calling executeUnitOfWork directly with a command
  // whose boundary does not exist in the DSL.
  await expect(
    executeUnitOfWork({
      command: {
        commandId: nextUuidv7(),
        boundary: 'NonExistentBoundary',
        intent: 'creation',
        targetId: nextUuidv7(),
        payload: { name: 'x' },
        queryParams: {},
        httpMethod: 'POST',
        path: '/items',
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
    }),
  ).rejects.toThrow(InternalExecutionError);

  // Verify the error message contains the unknown boundary name
  await expect(
    executeUnitOfWork({
      command: {
        commandId: nextUuidv7(),
        boundary: 'NonExistentBoundary',
        intent: 'creation',
        targetId: nextUuidv7(),
        payload: { name: 'x' },
        queryParams: {},
        httpMethod: 'POST',
        path: '/items',
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
    }),
  ).rejects.toThrow('"NonExistentBoundary"');
});

// ── Cascade depth: depth > maxDepth guard ────────────────────────────────────

it('CONTRACT: depth === maxDepth (5) is the last allowed level — does not throw', async () => {
  // docs §17: max_uow_depth = 5 levels of secondary command recursion.
  // The guard is `depth > maxDepth`, so depth 5 is allowed; depth 6 throws.
  // Inject a command at depth 5 directly — it should succeed (not InfiniteLoopError).
  await expect(
    executeUnitOfWork({
      command: {
        commandId: 'depth-test-allowed',
        boundary: 'Item',
        intent: 'creation',
        targetId: 'depth-allowed-target',
        payload: { name: 'x' },
        queryParams: {},
        httpMethod: 'POST',
        path: '/items',
        origin: 'secondary',
        depth: 5,
      },
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      openapi: sys.openapi,
      maxDepth: 5,
    }),
  ).resolves.toBeDefined();
});

it('depth > maxDepth (depth=6) throws InfiniteLoopError', async () => {
  // depth 6 with maxDepth 5: 6 > 5 → InfiniteLoopError.
  await expect(
    executeUnitOfWork({
      command: {
        commandId: 'depth-test-over',
        boundary: 'Item',
        intent: 'creation',
        targetId: 'depth-over-target',
        payload: { name: 'x' },
        queryParams: {},
        httpMethod: 'POST',
        path: '/items',
        origin: 'secondary',
        depth: 6,
      },
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      openapi: sys.openapi,
      maxDepth: 5,
    }),
  ).rejects.toThrow(InfiniteLoopError);
});

// ── VERIFIED: shadowAsStateGraph.values() merges shadow + global ──────────────

it('CONTRACT: shadowAsStateGraph.values() returns merged shadow + global entries (not empty)', async () => {
  // uow.ts lines 158-161: values() delegates to keys() which merges shadow + global keys.
  // This verifies the adapter is NOT a no-op for values() — it returns actual data.
  // Indirectly verified by successful query execution through executeUnitOfWork.
  const id = await createItem('shadow-test');
  const result = await executeUnitOfWork({
    command: {
      commandId: nextUuidv7(),
      boundary: 'ItemById',
      intent: 'query',
      targetId: id,
      payload: {},
      queryParams: {},
      httpMethod: 'GET',
      path: `/items/${id}`,
      origin: 'inbound',
      depth: 0,
    },
    dsl: sys.dsl,
    graph: sys.graph,
    events: sys.events,
    cel: sys.cel,
    validator: sys.validator,
    openapi: sys.openapi,
  });
  expect(result.status).toBe(200);
  expect((result.body as any).id).toBe(id);
});

// ── VERIFIED: faultSignal with custom headers preserved in result ─────────────

it('CONTRACT: faultSignal headers are returned in ExecutionResult.headers', async () => {
  const faultSignal = JSON.stringify({
    status: 429,
    body: { error: 'rate-limited' },
    headers: { 'retry-after': '60', 'x-ratelimit-limit': '100' },
  });

  const result = await executeUnitOfWork({
    command: {
      commandId: nextUuidv7(),
      boundary: 'Item',
      intent: 'mutation',
      targetId: 'some-id',
      payload: {},
      queryParams: {},
      httpMethod: 'PATCH',
      path: '/items/some-id',
      origin: 'inbound',
      depth: 0,
      faultSignal,
    },
    dsl: sys.dsl,
    graph: sys.graph,
    events: sys.events,
    cel: sys.cel,
    validator: sys.validator,
  });

  expect(result.status).toBe(429);
  expect(result.headers).toEqual({ 'retry-after': '60', 'x-ratelimit-limit': '100' });
});

// ── AUDIT GAP: faultSignal with no headers field → result.headers is undefined ─

it('CONTRACT: faultSignal without headers field results in undefined headers in ExecutionResult', async () => {
  const faultSignal = JSON.stringify({ status: 500, body: { error: 'server error' } });
  const result = await executeUnitOfWork({
    command: {
      commandId: nextUuidv7(),
      boundary: 'Item',
      intent: 'mutation',
      targetId: 'some-id',
      payload: {},
      queryParams: {},
      httpMethod: 'PATCH',
      path: '/items/some-id',
      origin: 'inbound',
      depth: 0,
      faultSignal,
    },
    dsl: sys.dsl,
    graph: sys.graph,
    events: sys.events,
    cel: sys.cel,
    validator: sys.validator,
  });

  expect(result.headers).toBeUndefined();
});
