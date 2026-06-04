/**
 * infinite-loop.integration.test.ts
 *
 * Integration test: synthesise a DSL with mutually recursive secondary commands;
 * assert InfiniteLoopError at depth > 5 (depth 6 and above).
 *
 * We build a minimal inline DSL entirely within this test — no fixture file required.
 *
 * The DSL defines two boundaries (PingBoundary / PongBoundary) that each dispatch
 * a secondary command targeting the other, creating a mutual recursion:
 *
 *   Ping → dispatch secondary Pong → dispatch secondary Ping → … → depth limit
 */

import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { executeUnitOfWork } from '../../src/engine/uow.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import { InfiniteLoopError } from '../../src/errors.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';

// ---------------------------------------------------------------------------
// Inline OpenAPI for the ping-pong scenario
// ---------------------------------------------------------------------------
const PING_PONG_OPENAPI = `
openapi: "3.0.3"
info:
  title: PingPong Test
  version: "1.0.0"
paths:
  /pings:
    post:
      operationId: createPing
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: object
      responses:
        "201":
          description: Ping created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/PingBoundary"
        "508":
          description: Loop detected
          content:
            application/json:
              schema:
                type: object
  /pongs:
    post:
      operationId: createPong
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: object
      responses:
        "201":
          description: Pong created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/PongBoundary"
        "508":
          description: Loop detected
          content:
            application/json:
              schema:
                type: object
components:
  schemas:
    PingBoundary:
      type: object
      properties:
        id:
          type: string
    PongBoundary:
      type: object
      properties:
        id:
          type: string
`;

// PingBoundary dispatches a secondary command to PongBoundary
const PING_DSL = `
boundary: PingBoundary
contract_path: /pings
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: PingCreated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: create-ping
    match:
      operationId: createPing
      condition: "true"
    emit: PingCreated
    dispatch_commands:
      - boundary: PongBoundary
        intent: creation
        operationId: createPong
        target_id: "$uuidv7()"
        payload: {}
reducers:
  - on: PingCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
`;

// PongBoundary dispatches a secondary command back to PingBoundary
const PONG_DSL = `
boundary: PongBoundary
contract_path: /pongs
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: PongCreated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: create-pong
    match:
      operationId: createPong
      condition: "true"
    emit: PongCreated
    dispatch_commands:
      - boundary: PingBoundary
        intent: creation
        operationId: createPing
        target_id: "$uuidv7()"
        payload: {}
reducers:
  - on: PongCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
`;

describe('infinite-loop.integration: mutually recursive secondary commands', () => {
  let sys: BootedSystem;

  beforeEach(async () => {
    const openapi = await loadOpenApi(PING_PONG_OPENAPI);
    sys = await bootSystem({
      openapi,
      compiledDsl: await compileDsl([
        { name: 'ping', yaml: PING_DSL },
        { name: 'pong', yaml: PONG_DSL },
      ]),
    });
  });

  it('throws InfiniteLoopError when mutual recursion exceeds maxDepth=5', async () => {
    const cmd = {
      commandId: nextUuidv7(),
      boundary: 'PingBoundary',
      intent: 'creation' as const,
      targetId: nextUuidv7(),
      payload: {},
      queryParams: {},
      httpMethod: 'POST',
      path: '/pings',
      origin: 'inbound' as const,
      depth: 0,
    };

    await expect(
      executeUnitOfWork({
        command: cmd,
        dsl: sys.dsl,
        openapi: sys.openapi,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        schemaRegistry: sys.schemaRegistry,
        maxDepth: 5,
      }),
    ).rejects.toBeInstanceOf(InfiniteLoopError);
  });

  it('InfiniteLoopError has code INFINITE_LOOP', async () => {
    const cmd = {
      commandId: nextUuidv7(),
      boundary: 'PingBoundary',
      intent: 'creation' as const,
      targetId: nextUuidv7(),
      payload: {},
      queryParams: {},
      httpMethod: 'POST',
      path: '/pings',
      origin: 'inbound' as const,
      depth: 0,
    };

    try {
      await executeUnitOfWork({
        command: cmd,
        dsl: sys.dsl,
        openapi: sys.openapi,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        schemaRegistry: sys.schemaRegistry,
        maxDepth: 5,
      });
      fail('Expected InfiniteLoopError');
    } catch (err) {
      expect(err).toBeInstanceOf(InfiniteLoopError);
      expect((err as InfiniteLoopError).code).toBe('INFINITE_LOOP');
    }
  });

  it('no events are committed to the event store when a loop is detected', async () => {
    const initialSize = sys.events.size();

    const cmd = {
      commandId: nextUuidv7(),
      boundary: 'PingBoundary',
      intent: 'creation' as const,
      targetId: nextUuidv7(),
      payload: {},
      queryParams: {},
      httpMethod: 'POST',
      path: '/pings',
      origin: 'inbound' as const,
      depth: 0,
    };

    await expect(
      executeUnitOfWork({
        command: cmd,
        dsl: sys.dsl,
        openapi: sys.openapi,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        schemaRegistry: sys.schemaRegistry,
        maxDepth: 5,
      }),
    ).rejects.toBeInstanceOf(InfiniteLoopError);

    // Event store must not have grown
    expect(sys.events.size()).toBe(initialSize);
  });

  it('a command at depth > maxDepth triggers the error immediately', async () => {
    // maxDepth=5 allows depths 0–5; depth 6 is the first rejected level.
    const cmd = {
      commandId: nextUuidv7(),
      boundary: 'PingBoundary',
      intent: 'creation' as const,
      targetId: nextUuidv7(),
      payload: {},
      queryParams: {},
      httpMethod: 'POST',
      path: '/pings',
      origin: 'secondary' as const,
      depth: 6,
    };

    await expect(
      executeUnitOfWork({
        command: cmd,
        dsl: sys.dsl,
        openapi: sys.openapi,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        schemaRegistry: sys.schemaRegistry,
        maxDepth: 5,
      }),
    ).rejects.toBeInstanceOf(InfiniteLoopError);
  });
});

// ---------------------------------------------------------------------------
// Cascade-depth cap EXACT boundary (ng5u): the guard is `cmd.depth > maxDepth`,
// so depth === maxDepth is the LAST allowed level and maxDepth+1 is rejected.
// A `>=` regression would wrongly reject depth === maxDepth; these two tests
// pin both sides of the boundary so that regression fails.
//
// A standalone non-dispatching Leaf boundary is used so the command entering at
// a given depth does NOT itself cascade — isolating the depth check from any
// follow-on cascade level.
// ---------------------------------------------------------------------------

const LEAF_OPENAPI = `
openapi: "3.0.3"
info:
  title: Leaf Depth Test
  version: "1.0.0"
paths:
  /leaves:
    post:
      operationId: createLeaf
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: object
      responses:
        "201":
          description: Leaf created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/LeafBoundary"
components:
  schemas:
    LeafBoundary:
      type: object
      properties:
        id:
          type: string
`;

const LEAF_DSL = `
boundary: LeafBoundary
contract_path: /leaves
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: LeafCreated
    payload_template:
      id: "command.targetId"
behaviors:
  - name: create-leaf
    match:
      operationId: createLeaf
      condition: "true"
    emit: LeafCreated
reducers:
  - on: LeafCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
`;

describe('infinite-loop.integration: cascade-depth cap exact boundary', () => {
  let leafSys: BootedSystem;
  const MAX_DEPTH = 3;

  beforeEach(async () => {
    const openapi = await loadOpenApi(LEAF_OPENAPI);
    leafSys = await bootSystem({
      openapi,
      compiledDsl: await compileDsl([{ name: 'leaf', yaml: LEAF_DSL }]),
    });
  });

  function leafCmd(depth: number) {
    return {
      commandId: nextUuidv7(),
      boundary: 'LeafBoundary',
      intent: 'creation' as const,
      targetId: nextUuidv7(),
      payload: {},
      queryParams: {},
      httpMethod: 'POST',
      path: '/leaves',
      origin: depth === 0 ? ('inbound' as const) : ('secondary' as const),
      depth,
    };
  }

  it('a command at depth === maxDepth executes (last allowed level)', async () => {
    const result = await executeUnitOfWork({
      command: leafCmd(MAX_DEPTH),
      dsl: leafSys.dsl,
      openapi: leafSys.openapi,
      graph: leafSys.graph,
      events: leafSys.events,
      cel: leafSys.cel,
      validator: leafSys.validator,
      schemaRegistry: leafSys.schemaRegistry,
      maxDepth: MAX_DEPTH,
    });

    expect(result.status).toBe(201);
    expect(result.events).toHaveLength(1);
  });

  it('a command at depth === maxDepth + 1 is rejected with InfiniteLoopError', async () => {
    await expect(
      executeUnitOfWork({
        command: leafCmd(MAX_DEPTH + 1),
        dsl: leafSys.dsl,
        openapi: leafSys.openapi,
        graph: leafSys.graph,
        events: leafSys.events,
        cel: leafSys.cel,
        validator: leafSys.validator,
        schemaRegistry: leafSys.schemaRegistry,
        maxDepth: MAX_DEPTH,
      }),
    ).rejects.toBeInstanceOf(InfiniteLoopError);
  });
});
