/**
 * RED TEAM — combo 6: RESET × IN-FLIGHT side-effect.
 *
 * Sagas (and webhooks) run AFTER commit, fire-and-forget. resetSystem() is
 * synchronous and purges the event store + state graph + aggregate locks, with
 * the documented assumption that reset is called "quiescently (no in-flight
 * UoW)". But a post-commit saga thunk can still be pending when a reset lands.
 *
 * Invariant: after a reset, the event store must contain ONLY the frozen
 * baseline — no orphaned events from a side-effect that was scheduled before the
 * reset but executed after it.
 *
 * This repro makes the race deterministic by capturing the post-commit saga via
 * the SideEffectQueue (the same deferral mechanism the bulk path uses), running
 * the reset while the thunk is still queued, then flushing the thunk — exactly
 * modelling "side-effect scheduled before reset, runs after reset".
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

describe('RED TEAM combo6: reset while a post-commit saga is pending', () => {
  let sys: BootedSystem;

  beforeEach(async () => {
    sys = await buildSystem();
  });

  afterEach(() => resetSystem(sys));

  it('a saga scheduled before reset does not orphan events into the reset store', async () => {
    const baselineCount = sys.frozenBaseline.length;

    // Capture the post-commit saga thunk instead of firing it inline — models a
    // side-effect that has been scheduled but not yet executed.
    const queue = createSideEffectQueue();

    const cmd: Command = {
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

    await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      openapi: sys.openapi,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      inferredSchemas: sys.inferredSchemas,
      deferSideEffects: queue,
    });

    // The saga thunk is queued (LoanOpened committed, saga not yet run).
    expect(queue.size()).toBeGreaterThan(0);

    // RESET happens now — purges store + graph + locks back to baseline.
    resetSystem(sys);
    expect(sys.events.size()).toBe(baselineCount);

    // The pending saga thunk now runs (it was scheduled before the reset).
    queue.flush(sys.logger);
    // Allow the async saga run (and its step UoW) to settle.
    await new Promise((r) => setTimeout(r, 20));

    // INVARIANT: the store still holds ONLY the baseline — the late saga must not
    // have appended orphaned saga/step events into the freshly-reset store.
    expect(sys.events.size()).toBe(baselineCount);
  });
});
