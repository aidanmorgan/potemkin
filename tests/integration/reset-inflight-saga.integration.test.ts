/**
 * reset-inflight-saga.integration.test.ts
 *
 * A post-commit side-effect (saga, webhook) that was scheduled before a
 * resetSystem() call must be silently discarded; it must not append orphan events
 * into the freshly-reset store and corrupt the deterministic baseline.
 *
 * Sagas (and webhooks) run AFTER commit, fire-and-forget. resetSystem() is
 * synchronous and purges the event store + state graph + locks back to the
 * frozen baseline, under the documented assumption that it is called quiescently
 * (no in-flight UoW). A post-commit saga thunk can still be pending when a reset
 * lands; the reset epoch mechanism ensures it no-ops.
 *
 * The system carries a monotonic reset epoch on BootedSystem. resetSystem
 * increments it; each post-commit side-effect thunk captures the epoch in force
 * when it is scheduled and no-ops if the epoch has advanced by the time it runs.
 *
 * Invariant: after a reset, the event store contains ONLY the frozen baseline —
 * no orphaned events from a side-effect scheduled before but executed after the
 * reset. A side-effect with NO intervening reset must still fire fully.
 */

import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { executeUnitOfWork } from '../../src/engine/uow.js';
import { resetSystem } from '../../src/engine/reset.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import { createSideEffectQueue } from '../../src/engine/sideEffects.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import type { Command } from '../../src/types.js';

const OPENAPI_YAML = `
openapi: "3.0.3"
info: { title: Reset Inflight Saga, version: "1.0.0" }
paths:
  /loans:
    post:
      operationId: createLoan
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: "#/components/schemas/Loan" } } }
      responses:
        "201": { description: Created, content: { application/json: { schema: { $ref: "#/components/schemas/Loan" } } } }
  /ledgers/{id}:
    put:
      operationId: updateLedger
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: "#/components/schemas/Ledger" } } }
      responses:
        "200": { description: OK, content: { application/json: { schema: { $ref: "#/components/schemas/Ledger" } } } }
    get:
      operationId: getLedger
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses:
        "200": { description: OK, content: { application/json: { schema: { $ref: "#/components/schemas/Ledger" } } } }
components:
  schemas:
    Loan:
      type: object
      properties: { id: { type: string } }
      required: [id]
    Ledger:
      type: object
      properties: { id: { type: string }, balance: { type: integer } }
      required: [id, balance]
`;

const LOAN_DSL = `
boundary: Loan
contract_path: /loans
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: LoanOpened
    payload_template:
      id: "command.targetId"
behaviors:
  - name: open-loan
    match:
      operationId: createLoan
      condition: "true"
    emit: LoanOpened
reducers:
  - on: LoanOpened
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
`;

const LEDGER_FIXED_ID = '00000000-0000-7000-8000-0000000000cc';

const LEDGER_DSL = `
boundary: Ledger
contract_path: /ledgers/{id}
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: LedgerCredited
    payload_template:
      id: "command.targetId"
behaviors:
  - name: credit
    match:
      operationId: updateLedger
      condition: "true"
    emit: LedgerCredited
reducers:
  - on: LedgerCredited
    patches:
      - { op: replace, path: /id, value: "\${event.payload.id}" }
      - { op: increment, path: /balance, by: 1 }
initialization:
  - id: "00000000-0000-7000-8000-0000000000cc"
    balance: 0
`;

// Saga: on LoanOpened, run a step that credits the Ledger (appends events to the store).
const GLOBAL_YAML = `
sagas:
  - name: CreditLedgerOnLoan
    trigger:
      boundary: Loan
      intent: creation
      condition: "true"
    steps:
      - name: credit
        boundary: Ledger
        intent: mutation
        operationId: updateLedger
        target_id: '"${LEDGER_FIXED_ID}"'
        payload: {}
`;

async function buildSystem(): Promise<BootedSystem> {
  const openapi = await loadOpenApi(OPENAPI_YAML);
  const compiledDsl = await compileDsl(
    [
      { name: 'loan', yaml: LOAN_DSL },
      { name: 'ledger', yaml: LEDGER_DSL },
    ],
    GLOBAL_YAML,
  );
  return bootSystem({ openapi, compiledDsl });
}

/** Let post-commit fire-and-forget side-effects (the saga + its step UoW) settle. */
async function flushSideEffects(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

function openLoan(): Command {
  return {
    commandId: nextUuidv7(),
    boundary: 'Loan',
    intent: 'creation',
    targetId: nextUuidv7(),
    payload: {},
    queryParams: {},
    httpMethod: 'POST',
    path: '/loans',
    origin: 'inbound',
    depth: 0,
  };
}

describe('reset epoch suppresses in-flight side-effects', () => {
  let sys: BootedSystem;

  beforeEach(async () => {
    sys = await buildSystem();
  });

  afterEach(() => resetSystem(sys));

  it('a saga scheduled before resetSystem appends no events after the reset (store stays at baseline)', async () => {
    const baselineCount = sys.frozenBaseline.length;

    // Capture the post-commit saga thunk instead of firing it inline — models a
    // side-effect that has been scheduled but not yet executed. The queue is the
    // same deferral mechanism the bulk path uses; the epoch guard is baked into
    // the thunk at scheduling time, so it protects the deferred path too.
    const queue = createSideEffectQueue();

    await executeUnitOfWork({
      command: openLoan(),
      dsl: sys.dsl,
      openapi: sys.openapi,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      aggregateLocks: sys.aggregateLocks,
      resetEpoch: sys.resetEpoch,
      inferredSchemas: sys.inferredSchemas,
      deferSideEffects: queue,
    });

    // The saga thunk is queued (LoanOpened committed, saga not yet run).
    expect(queue.size()).toBeGreaterThan(0);

    // RESET happens now — purges store + graph + locks back to baseline and
    // advances the reset epoch.
    resetSystem(sys);
    expect(sys.events.size()).toBe(baselineCount);

    // The pending saga thunk now runs (it was scheduled before the reset). The
    // epoch it captured no longer matches, so it must no-op.
    queue.flush(sys.logger);
    await flushSideEffects();

    // INVARIANT: the store still holds ONLY the baseline — the late saga did not
    // append orphaned saga/step events into the freshly-reset store.
    expect(sys.events.size()).toBe(baselineCount);
    const sagaEvents = sys.events.all().filter((e) => e.boundary === '__saga__');
    expect(sagaEvents).toHaveLength(0);
  });

  it('a saga with no intervening reset still fires fully', async () => {
    const baselineCount = sys.frozenBaseline.length;

    // Fire the side-effect inline (no deferral, no reset). The captured epoch
    // matches the live epoch, so the saga runs to completion.
    await executeUnitOfWork({
      command: openLoan(),
      dsl: sys.dsl,
      openapi: sys.openapi,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      aggregateLocks: sys.aggregateLocks,
      resetEpoch: sys.resetEpoch,
      inferredSchemas: sys.inferredSchemas,
    });

    await flushSideEffects();

    // The saga started and credited the ledger — orphan-free but NON-empty:
    // events grew beyond baseline (LoanOpened + SagaStarted + LedgerCredited + ...).
    expect(sys.events.size()).toBeGreaterThan(baselineCount);

    const started = sys.events
      .all()
      .filter((e) => e.boundary === '__saga__' && e.type === 'SagaStarted');
    expect(started).toHaveLength(1);
    expect(started[0].payload['sagaName']).toBe('CreditLedgerOnLoan');

    const credited = sys.events.all().filter((e) => e.type === 'LedgerCredited');
    expect(credited).toHaveLength(1);
  });
});
