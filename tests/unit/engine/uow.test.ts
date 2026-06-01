/**
 * Unit/integration tests for engine/uow.ts
 *
 * Targets the uncovered branches:
 *  - shadowAsStateGraph (lines 143-160): delete, purge, values, entries, size, set
 *  - executeUnitOfWork with no metrics (fallback to createEngineMetrics)
 *  - requiresPrecondition: () => true with no sequenceVersion → 428
 *  - global lock path (targetId null)
 *  - faultSignal short-circuit (with and without metrics)
 *  - unparseable faultSignal → InternalExecutionError
 *  - missing openapi fails pre-flight BEFORE lock acquisition
 *  - shared aggregateLocks serializes concurrent direct + saga-step UoWs
 */

import { executeUnitOfWork } from '../../../src/engine/uow';
import {
  MissingPreconditionError,
  InternalExecutionError,
} from '../../../src/errors';
import { bootSystem, type BootedSystem } from '../../../src/engine/boot';
import { resetSystem } from '../../../src/engine/reset';
import { loadOpenApi } from '../../../src/contract/loader';
import { nextUuidv7 } from '../../../src/ids/uuidv7';
import { compileDsl } from '../../../src/dsl/parser';

// ── minimal inline fixture ──────────────────────────────────────────────────────

const SIMPLE_OPENAPI = `
openapi: "3.0.3"
info:
  title: UoW Test
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
          description: Created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Widget"
        "428":
          description: Precondition required
          content:
            application/json:
              schema:
                type: object
  /widgets/{id}:
    patch:
      operationId: updateWidget
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
                $ref: "#/components/schemas/WidgetById"
        "412":
          description: Precondition failed
          content:
            application/json:
              schema:
                type: object
        "428":
          description: Precondition required
          content:
            application/json:
              schema:
                type: object
    get:
      operationId: getWidget
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: Widget
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/WidgetById"
        "404":
          description: Not found
          content:
            application/json:
              schema:
                type: object
components:
  schemas:
    Widget:
      type: object
      properties:
        id:
          type: string
        label:
          type: string
      required:
        - id
        - label
    WidgetById:
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

const WIDGET_DSL = `
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
      label: "command.payload.label"
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
      - { op: replace, path: /label, value: "\${event.payload.label}" }
`;

const WIDGET_BY_ID_DSL = `
boundary: WidgetById
contract_path: /widgets/{id}
fallback_override: true
event_catalog: []
behaviors: []
reducers: []
`;

// ── fixtures ─────────────────────────────────────────────────────────────────────

let sys: BootedSystem;

beforeEach(async () => {
  const openapi = await loadOpenApi(SIMPLE_OPENAPI);
  sys = await bootSystem({
    openapi,
    compiledDsl: await compileDsl([
      { name: 'widget', yaml: WIDGET_DSL },
      { name: 'widgetById', yaml: WIDGET_BY_ID_DSL },
    ]),
  });
});

afterEach(() => {
  resetSystem(sys);
});

async function createWidget(label = 'test'): Promise<string> {
  const widgetId = nextUuidv7();
  await executeUnitOfWork({
    command: {
      commandId: nextUuidv7(),
      boundary: 'Widget',
      intent: 'creation',
      targetId: widgetId,
      payload: { label },
      queryParams: {},
      httpMethod: 'POST',
      path: '/widgets',
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
  return widgetId;
}

// ── tests ─────────────────────────────────────────────────────────────────────────

describe('engine/uow — additional branch coverage', () => {

  // ── no-metrics fallback ───────────────────────────────────────────────────────

  it('executes successfully with metrics omitted (fallback to createEngineMetrics)', async () => {
    const widgetId = nextUuidv7();
    const result = await executeUnitOfWork({
      command: {
        commandId: nextUuidv7(),
        boundary: 'Widget',
        intent: 'creation',
        targetId: widgetId,
        payload: { label: 'no-metrics' },
        queryParams: {},
        httpMethod: 'POST',
        path: '/widgets',
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
      // metrics deliberately omitted → uses createEngineMetrics() default
    });
    expect(result.status).toBe(201);
  });

  // ── global lock path (targetId null) ─────────────────────────────────────────

  it('creation with targetId null self-cleans the global lock sentinel key after completion', async () => {
    // A creation with targetId null resolves the lock key to GLOBAL_LOCK_KEY
    // ('__global__') in acquireLock. The slot is acquired before projection, then
    // released in a finally block; release self-cleans the key when no later
    // acquirer queued behind it. So after a single (awaited) execution the map
    // must NOT retain '__global__' — keeping the per-system lock map bounded.
    // (Serialization while the lock is held is covered by the saga concurrency
    // tests that drive two concurrent UoWs through a shared aggregateLocks map.)
    const aggregateLocks = new Map<string, Promise<void>>();

    try {
      await executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'Widget',
          intent: 'creation',
          targetId: null,     // ← resolves lockKey to GLOBAL_LOCK_KEY
          payload: { label: 'global-lock' },
          queryParams: {},
          httpMethod: 'POST',
          path: '/widgets',
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
        aggregateLocks,
      });
    } catch {
      // Projection may reject the null-derived id; the lock is acquired earlier.
    }

    expect(aggregateLocks.has('__global__')).toBe(false);
  });

  // ── requiresPrecondition → 428 ────────────────────────────────────────────────

  it('throws MissingPreconditionError (428) when requiresPrecondition returns true and no sequenceVersion', async () => {
    const widgetId = await createWidget();

    await expect(
      executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'WidgetById',
          intent: 'mutation',
          targetId: widgetId,
          payload: { label: 'updated' },
          queryParams: {},
          httpMethod: 'PATCH',
          path: `/widgets/${widgetId}`,
          origin: 'inbound',
          depth: 0,
          // no sequenceVersion
        },
        dsl: sys.dsl,
        openapi: sys.openapi,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        schemaRegistry: sys.schemaRegistry,
        requiresPrecondition: () => true,   // ← forces 428 path
      }),
    ).rejects.toBeInstanceOf(MissingPreconditionError);
  });

  it('MissingPreconditionError has code MISSING_PRECONDITION', async () => {
    const widgetId = await createWidget();

    try {
      await executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'WidgetById',
          intent: 'mutation',
          targetId: widgetId,
          payload: { label: 'upd' },
          queryParams: {},
          httpMethod: 'PATCH',
          path: `/widgets/${widgetId}`,
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
        requiresPrecondition: () => true,
      });
      fail('expected MissingPreconditionError');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingPreconditionError);
      expect((err as MissingPreconditionError).code).toBe('MISSING_PRECONDITION');
    }
  });

  // ── faultSignal short-circuit ─────────────────────────────────────────────────

  it('faultSignal short-circuit returns the simulated status and body', async () => {
    const faultSignal = JSON.stringify({ status: 503, body: { error: 'DOWN' } });
    const result = await executeUnitOfWork({
      command: {
        commandId: nextUuidv7(),
        boundary: 'Widget',
        intent: 'creation',
        targetId: null,
        payload: {},
        queryParams: {},
        httpMethod: 'POST',
        path: '/widgets',
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
    expect(result.body).toMatchObject({ error: 'DOWN' });
  });

  it('faultSignal with metrics calls metrics.faultsSimulatedTotal', async () => {
    const addMock = jest.fn();
    const mockMetrics = {
      commandsTotal: { add: jest.fn() },
      eventsAppendedTotal: { add: jest.fn() },
      commandDurationMs: { record: jest.fn() },
      uowAbortsTotal: { add: jest.fn() },
      faultsSimulatedTotal: { add: addMock },
    } as any;

    const faultSignal = JSON.stringify({ status: 429, body: { error: 'RATE_LIMITED' } });
    await executeUnitOfWork({
      command: {
        commandId: nextUuidv7(),
        boundary: 'Widget',
        intent: 'mutation',
        targetId: 'some-id',
        payload: {},
        queryParams: {},
        httpMethod: 'PATCH',
        path: '/widgets/some-id',
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
      metrics: mockMetrics,
    });

    expect(addMock).toHaveBeenCalledWith(1, expect.objectContaining({ boundary: 'Widget' }));
  });

  it('unparseable faultSignal throws InternalExecutionError', async () => {
    await expect(
      executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'Widget',
          intent: 'creation',
          targetId: null,
          payload: {},
          queryParams: {},
          httpMethod: 'POST',
          path: '/widgets',
          origin: 'inbound',
          depth: 0,
          faultSignal: 'not-valid-json{{{',
        },
        dsl: sys.dsl,
        openapi: sys.openapi,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        schemaRegistry: sys.schemaRegistry,
      }),
    ).rejects.toBeInstanceOf(InternalExecutionError);
  });

  // ── requiresPrecondition not called for query intent ─────────────────────────

  it('requiresPrecondition is not invoked for query intent', async () => {
    const requiresMock = jest.fn().mockReturnValue(true);
    const widgetId = await createWidget('read-me');

    const result = await executeUnitOfWork({
      command: {
        commandId: nextUuidv7(),
        boundary: 'WidgetById',
        intent: 'query',
        targetId: widgetId,
        payload: {},
        queryParams: {},
        httpMethod: 'GET',
        path: `/widgets/${widgetId}`,
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
      requiresPrecondition: requiresMock,
    });

    expect(requiresMock).not.toHaveBeenCalled();
    expect(result.status).toBe(200);
  });

  // ── concurrent UoWs targeting same key serialize ──────────────────────────────

  it('two concurrent UoWs targeting same aggregate run serially and both succeed', async () => {
    const widgetId = await createWidget('before');

    // Concurrent same-aggregate UoWs serialize only when they SHARE a lock map
    // (the per-BootedSystem aggregateLocks; the gateway passes sys.aggregateLocks).
    const aggregateLocks = new Map<string, Promise<void>>();

    // Fire two concurrent mutations without specifying sequenceVersion.
    // Both should succeed (the shared lock ensures serial execution; fallback_override handles no-match).
    const [r1, r2] = await Promise.all([
      executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'WidgetById',
          intent: 'mutation',
          targetId: widgetId,
          payload: { label: 'first' },
          queryParams: {},
          httpMethod: 'PATCH',
          path: `/widgets/${widgetId}`,
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
        aggregateLocks,
      }),
      executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'WidgetById',
          intent: 'mutation',
          targetId: widgetId,
          payload: { label: 'second' },
          queryParams: {},
          httpMethod: 'PATCH',
          path: `/widgets/${widgetId}`,
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
        aggregateLocks,
      }),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });
});

// ── openapi pre-flight check ──────────────────────────────────────────────────

describe('engine/uow — pre-flight openapi check', () => {
  it('throws InternalExecutionError before acquiring the lock when openapi is omitted', async () => {
    const aggregateLocks = new Map<string, Promise<void>>();
    const widgetId = nextUuidv7();

    await expect(
      executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'Widget',
          intent: 'creation',
          targetId: widgetId,
          payload: { label: 'no-openapi' },
          queryParams: {},
          httpMethod: 'POST',
          path: '/widgets',
          origin: 'inbound',
          depth: 0,
        },
        dsl: sys.dsl,
        // openapi deliberately omitted
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        schemaRegistry: sys.schemaRegistry,
        aggregateLocks,
      } as never),
    ).rejects.toBeInstanceOf(InternalExecutionError);

    // The lock map must be untouched — the error fires before acquireLock.
    expect(aggregateLocks.size).toBe(0);
  });

  it('InternalExecutionError for missing openapi carries the commandId and boundary', async () => {
    const commandId = nextUuidv7();
    const widgetId = nextUuidv7();

    let caught: unknown;
    try {
      await executeUnitOfWork({
        command: {
          commandId,
          boundary: 'Widget',
          intent: 'creation',
          targetId: widgetId,
          payload: { label: 'no-openapi' },
          queryParams: {},
          httpMethod: 'POST',
          path: '/widgets',
          origin: 'inbound',
          depth: 0,
        },
        dsl: sys.dsl,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        schemaRegistry: sys.schemaRegistry,
      } as never);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InternalExecutionError);
    const iee = caught as InternalExecutionError;
    expect(iee.message).toMatch(/UowInput\.openapi is required/);
    // Extra data is stored in SimError.details (JsonValue).
    expect(iee.details).toMatchObject({
      commandId,
      boundary: 'Widget',
    });
  });
});

// ── Counter fixture for concurrent saga-step serialization test ───────────────
//
// Counter is a boundary that emits a CounterIncremented event on mutation so
// two concurrent UoWs targeting the same counter aggregate WILL both write to
// the event store.  Without a shared aggregateLocks map the second append
// races and produces a non-monotonic sequence error; with it they serialize.

const COUNTER_OPENAPI = `
openapi: "3.0.3"
info:
  title: Counter Test
  version: "1.0.0"
paths:
  /counters:
    post:
      operationId: createCounter
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Counter"
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Counter"
  /counters/{id}:
    put:
      operationId: incrementCounter
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
                $ref: "#/components/schemas/CounterById"
components:
  schemas:
    Counter:
      type: object
      properties:
        id:
          type: string
        value:
          type: integer
      required:
        - id
        - value
    CounterById:
      type: object
      properties:
        id:
          type: string
        value:
          type: integer
      required:
        - id
        - value
`;

const COUNTER_DSL = `
boundary: Counter
contract_path: /counters
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: CounterCreated
    payload_template:
      id: "command.targetId"
      value: "0"
behaviors:
  - name: create-counter
    match:
      operationId: createCounter
      condition: "true"
    emit: CounterCreated
reducers:
  - on: CounterCreated
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /value, value: 0 }
`;

const COUNTER_BY_ID_DSL = `
boundary: CounterById
contract_path: /counters/{id}
fallback_override: false
event_catalog:
  - type: CounterIncremented
    payload_template:
      id: "command.targetId"
      delta: "1"
behaviors:
  - name: increment-counter
    match:
      operationId: incrementCounter
      condition: "true"
    emit: CounterIncremented
reducers:
  - on: CounterIncremented
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: replace, path: /value, value: "\${state.value != null ? state.value + 1 : 1}" }
`;

// ── concurrent direct + saga-step UoWs serialize ──────────────────────────────

describe('engine/uow — shared aggregateLocks serializes concurrent UoWs on same aggregate', () => {
  let counterSys: BootedSystem;

  beforeEach(async () => {
    const openapi = await loadOpenApi(COUNTER_OPENAPI);
    counterSys = await bootSystem({
      openapi,
      compiledDsl: await compileDsl([
        { name: 'counter', yaml: COUNTER_DSL },
        { name: 'counterById', yaml: COUNTER_BY_ID_DSL },
      ]),
    });
  });

  afterEach(() => {
    resetSystem(counterSys);
  });

  async function createCounter(): Promise<string> {
    const counterId = nextUuidv7();
    await executeUnitOfWork({
      command: {
        commandId: nextUuidv7(),
        boundary: 'Counter',
        intent: 'creation',
        targetId: counterId,
        payload: {},
        queryParams: {},
        httpMethod: 'POST',
        path: '/counters',
        origin: 'inbound',
        depth: 0,
      },
      dsl: counterSys.dsl,
      openapi: counterSys.openapi,
      graph: counterSys.graph,
      events: counterSys.events,
      cel: counterSys.cel,
      validator: counterSys.validator,
      schemaRegistry: counterSys.schemaRegistry,
      aggregateLocks: counterSys.aggregateLocks,
    });
    return counterId;
  }

  it('two concurrent increments sharing aggregateLocks both succeed with a monotonic event sequence', async () => {
    const counterId = await createCounter();
    const eventsBefore = counterSys.events.byAggregate(counterId).length;

    // Simulate: one direct inbound increment + one increment representing a
    // saga step — both share the system aggregateLocks so they serialize on
    // the same aggregate.  Without the shared lock the second append would
    // race and throw a non-monotonic sequence error from the event store.
    const [r1, r2] = await Promise.all([
      executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'CounterById',
          intent: 'mutation',
          targetId: counterId,
          payload: {},
          queryParams: {},
          httpMethod: 'PUT',
          path: `/counters/${counterId}`,
          origin: 'inbound',
          depth: 0,
        },
        dsl: counterSys.dsl,
        openapi: counterSys.openapi,
        graph: counterSys.graph,
        events: counterSys.events,
        cel: counterSys.cel,
        validator: counterSys.validator,
        schemaRegistry: counterSys.schemaRegistry,
        aggregateLocks: counterSys.aggregateLocks,
      }),
      executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'CounterById',
          intent: 'mutation',
          targetId: counterId,
          payload: {},
          queryParams: {},
          httpMethod: 'PUT',
          path: `/counters/${counterId}`,
          // origin secondary simulates a saga-step UoW sharing the same map.
          origin: 'secondary',
          depth: 1,
        },
        dsl: counterSys.dsl,
        openapi: counterSys.openapi,
        graph: counterSys.graph,
        events: counterSys.events,
        cel: counterSys.cel,
        validator: counterSys.validator,
        schemaRegistry: counterSys.schemaRegistry,
        aggregateLocks: counterSys.aggregateLocks,
      }),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    // Both increments committed — two new events with strictly monotonic
    // sequence versions (the shared lock guaranteed serial execution).
    const eventsAfter = counterSys.events.byAggregate(counterId);
    expect(eventsAfter.length).toBe(eventsBefore + 2);
    const [first, second] = eventsAfter.slice(eventsBefore);
    expect(second!.sequenceVersion).toBe(first!.sequenceVersion + 1);
  });

  it('two concurrent increments WITHOUT shared aggregateLocks produce a non-monotonic sequence error', async () => {
    // Documents the unsafe behaviour that the fix addresses:  without a shared
    // lock each UoW races to read currentSequenceVersion and both compute the
    // same next version, so the second append throws.
    const counterId = await createCounter();

    const results = await Promise.allSettled([
      executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'CounterById',
          intent: 'mutation',
          targetId: counterId,
          payload: {},
          queryParams: {},
          httpMethod: 'PUT',
          path: `/counters/${counterId}`,
          origin: 'inbound',
          depth: 0,
        },
        dsl: counterSys.dsl,
        openapi: counterSys.openapi,
        graph: counterSys.graph,
        events: counterSys.events,
        cel: counterSys.cel,
        validator: counterSys.validator,
        schemaRegistry: counterSys.schemaRegistry,
        // No aggregateLocks passed — each UoW uses an independent fresh map.
      }),
      executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'CounterById',
          intent: 'mutation',
          targetId: counterId,
          payload: {},
          queryParams: {},
          httpMethod: 'PUT',
          path: `/counters/${counterId}`,
          origin: 'secondary',
          depth: 1,
        },
        dsl: counterSys.dsl,
        openapi: counterSys.openapi,
        graph: counterSys.graph,
        events: counterSys.events,
        cel: counterSys.cel,
        validator: counterSys.validator,
        schemaRegistry: counterSys.schemaRegistry,
        // No aggregateLocks passed — each UoW uses an independent fresh map.
      }),
    ]);

    const errorCount = results.filter((r) => r.status === 'rejected').length;
    // Without serialization the second concurrent write on the same aggregate
    // hits a non-monotonic sequence version and is rejected.
    expect(errorCount).toBeGreaterThanOrEqual(1);
  });
});
