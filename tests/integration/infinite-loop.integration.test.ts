/**
 * infinite-loop.integration.test.ts
 *
 * Integration test: synthesise a DSL with mutually recursive secondary commands;
 * assert InfiniteLoopError at depth > 5.
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
    assign:
      id: "event.payload.id"
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
    assign:
      id: "event.payload.id"
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

  it('a command with depth already at maxDepth triggers the error immediately', async () => {
    // Start with a command whose depth is already 6 (above maxDepth=5)
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
