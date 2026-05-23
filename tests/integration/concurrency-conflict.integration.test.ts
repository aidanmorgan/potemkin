/**
 * concurrency-conflict.integration.test.ts
 *
 * Integration test: drive two commands with stale sequenceVersion.
 *  - First wins (or both fail if the target doesn't need sequenceVersion).
 *  - Second throws ConcurrencyConflictError.
 *
 * We use the Customer boundary directly (no cascade) to avoid the known
 * append-runtime-guard bug that affects LoanAccount creation.
 * We create customers and then mutate them using the attach-loan behavior.
 */

import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { executeUnitOfWork } from '../../src/engine/uow.js';
import { resetSystem } from '../../src/engine/reset.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { ConcurrencyConflictError } from '../../src/errors.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import type { Command } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Minimal DSL: SimpleItem boundary without any append operations
// ---------------------------------------------------------------------------

const SIMPLE_OPENAPI = `
openapi: "3.0.3"
info:
  title: Concurrency Test
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
              $ref: "#/components/schemas/SimpleItem"
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/SimpleItem"
  /items/{id}:
    patch:
      operationId: updateItem
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: object
      responses:
        "200":
          description: Updated
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/SimpleItemById"
        "412":
          description: Precondition failed
          content:
            application/json:
              schema:
                type: object
components:
  schemas:
    SimpleItem:
      type: object
      properties:
        id:
          type: string
        value:
          type: string
      required:
        - id
        - value
    SimpleItemById:
      type: object
      properties:
        id:
          type: string
        value:
          type: string
      required:
        - id
        - value
`;

const SIMPLE_ITEM_DSL = `
boundary: SimpleItem
contract_path: /items
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: ItemCreated
    payload_template:
      id: "command.targetId"
      value: "command.payload.value"
behaviors:
  - name: create-item
    match:
      intent: creation
      condition: "true"
    emit: ItemCreated
reducers:
  - on: ItemCreated
    assign:
      id: "event.payload.id"
      value: "event.payload.value"
`;

const SIMPLE_ITEM_BY_ID_DSL = `
boundary: SimpleItemById
contract_path: /items/{id}
fallback_override: true
event_catalog: []
behaviors: []
reducers: []
`;

describe('concurrency-conflict.integration', () => {
  let sys: BootedSystem;

  beforeEach(async () => {
    const openapi = await loadOpenApi(SIMPLE_OPENAPI);
    sys = await bootSystem({
      openapi,
      dslModules: [
        { name: 'item', yaml: SIMPLE_ITEM_DSL },
        { name: 'itemById', yaml: SIMPLE_ITEM_BY_ID_DSL },
      ],
    });
  });

  afterEach(() => {
    resetSystem(sys);
  });

  async function createItem(value = 'initial'): Promise<string> {
    const itemId = nextUuidv7();
    await executeUnitOfWork({
      command: {
        commandId: nextUuidv7(),
        boundary: 'SimpleItem',
        intent: 'creation',
        targetId: itemId,
        payload: { value },
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
    });
    return itemId;
  }

  function makeUpdateCommand(targetId: string, sequenceVersion: number): Command {
    return {
      commandId: nextUuidv7(),
      boundary: 'SimpleItemById',
      intent: 'mutation',
      targetId,
      payload: { value: 'updated' },
      queryParams: {},
      httpMethod: 'PATCH',
      path: `/items/${targetId}`,
      origin: 'inbound',
      depth: 0,
      sequenceVersion,
    };
  }

  it('first command with correct sequenceVersion succeeds', async () => {
    const itemId = await createItem();
    const currentSeq = sys.events.currentSequenceVersion(itemId);

    const result = await executeUnitOfWork({
      command: makeUpdateCommand(itemId, currentSeq),
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
    });

    expect(result.status).toBe(200);
  });

  it('second command with stale sequenceVersion throws ConcurrencyConflictError', async () => {
    const itemId = await createItem();
    const currentSeq = sys.events.currentSequenceVersion(itemId);

    // First mutation succeeds (uses correct currentSeq)
    await executeUnitOfWork({
      command: makeUpdateCommand(itemId, currentSeq),
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
    });

    // Second mutation with the same (now stale) sequenceVersion must fail
    await expect(
      executeUnitOfWork({
        command: makeUpdateCommand(itemId, currentSeq),
        dsl: sys.dsl,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        schemaRegistry: sys.schemaRegistry,
      }),
    ).rejects.toBeInstanceOf(ConcurrencyConflictError);
  });

  it('ConcurrencyConflictError has code CONCURRENCY_CONFLICT', async () => {
    const itemId = await createItem();
    const staleSeq = sys.events.currentSequenceVersion(itemId);

    // Advance the version by issuing a successful mutation
    await executeUnitOfWork({
      command: makeUpdateCommand(itemId, staleSeq),
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
    });

    try {
      await executeUnitOfWork({
        command: makeUpdateCommand(itemId, staleSeq),
        dsl: sys.dsl,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        schemaRegistry: sys.schemaRegistry,
      });
      fail('Expected ConcurrencyConflictError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConcurrencyConflictError);
      expect((err as ConcurrencyConflictError).code).toBe('CONCURRENCY_CONFLICT');
    }
  });

  it('event store is not mutated when a concurrency conflict occurs', async () => {
    const itemId = await createItem();
    const staleSeq = sys.events.currentSequenceVersion(itemId);

    // Advance version
    await executeUnitOfWork({
      command: makeUpdateCommand(itemId, staleSeq),
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
    });

    const sizeBeforeConflict = sys.events.size();

    // This should fail without appending events
    await expect(
      executeUnitOfWork({
        command: makeUpdateCommand(itemId, staleSeq),
        dsl: sys.dsl,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        schemaRegistry: sys.schemaRegistry,
      }),
    ).rejects.toBeInstanceOf(ConcurrencyConflictError);

    expect(sys.events.size()).toBe(sizeBeforeConflict);
  });
});
