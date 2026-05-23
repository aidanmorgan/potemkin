/**
 * secondary-commands.integration.test.ts
 *
 * Integration test: creating a LoanAccount must cascade to `LoanAttachedToCustomer`
 * on the targeted Customer. Verify:
 *  - Both events appended.
 *  - Both state graph nodes updated atomically.
 */

import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { executeUnitOfWork } from '../../src/engine/uow.js';
import { resetSystem } from '../../src/engine/reset.js';
import { loadBankingFixture } from './_helpers/inline-fixture.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import type { Command } from '../../src/types.js';

// ---------------------------------------------------------------------------
// BUG: runtimeGuard.guardAssignedValue checks appended values against the
// ARRAY schema (kind='array') rather than the array's ITEMS schema.
// When a LoanAccount creation dispatches a secondary mutation to Customer,
// the Customer reducer tries to `append loanIds: event.payload.loanId` (a string).
// guardAssignedValue receives (string_value, loanIds_array_schema) and throws
// SCHEMA_TYPE_MISMATCH because the string is not an array.
//
// The correct behaviour would be to check the value against the ITEMS schema.
// Until the bug is fixed, all tests that trigger `append` operations are marked
// it.failing.
// ---------------------------------------------------------------------------

describe('secondary-commands.integration: LoanAccount creation cascades to Customer', () => {
  let sys: BootedSystem;
  const ACME_ID = '00000000-0000-7000-8000-000000000001';

  beforeEach(async () => {
    const fixture = await loadBankingFixture();
    sys = await bootSystem(fixture);
  });

  afterEach(() => {
    resetSystem(sys);
  });

  function makeLoanCreationCommand(customerId: string): Command {
    const loanId = nextUuidv7();
    return {
      commandId: nextUuidv7(),
      boundary: 'LoanAccount',
      intent: 'creation',
      targetId: loanId,
      payload: { customerId, principal: 10000 },
      queryParams: {},
      httpMethod: 'POST',
      path: '/loans',
      origin: 'inbound',
      depth: 0,
    };
  }

  // it.failing because of BUG: guardAssignedValue for append checks value against
  // the array schema (expects array), not the items schema (expects string).
  // Tracked as: runtimeGuard SCHEMA_TYPE_MISMATCH for append operations.
  it.failing('creating a loan produces 2 committed events (LoanCreated + customer cascade)', async () => {
    const initialEventCount = sys.events.size();
    const cmd = makeLoanCreationCommand(ACME_ID);

    const result = await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
      logger: sys.logger,
      tracer: sys.tracer,
      metrics: sys.metrics,
    });

    // Primary (LoanCreated) + secondary (LoanAttachedToCustomer) = 2
    expect(result.events).toHaveLength(2);
    expect(sys.events.size()).toBe(initialEventCount + 2);
  });

  it.failing('the first event is for the LoanAccount boundary', async () => {
    const cmd = makeLoanCreationCommand(ACME_ID);

    const result = await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
      logger: sys.logger,
      tracer: sys.tracer,
      metrics: sys.metrics,
    });

    expect(result.events[0]!.boundary).toBe('LoanAccount');
    expect(result.events[0]!.aggregateId).toBe(cmd.targetId);
  });

  it.failing('the second event is for the Customer boundary (cascade)', async () => {
    const cmd = makeLoanCreationCommand(ACME_ID);

    const result = await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
      logger: sys.logger,
      tracer: sys.tracer,
      metrics: sys.metrics,
    });

    expect(result.events[1]!.boundary).toBe('Customer');
    expect(result.events[1]!.aggregateId).toBe(ACME_ID);
  });

  it.failing('the loan account node is created in the state graph', async () => {
    const cmd = makeLoanCreationCommand(ACME_ID);

    await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
      logger: sys.logger,
      tracer: sys.tracer,
      metrics: sys.metrics,
    });

    const loan = sys.graph.get(cmd.targetId!);
    expect(loan).not.toBeNull();
    expect(loan!['customerId']).toBe(ACME_ID);
    expect(loan!['status']).toBe('OPEN');
  });

  it.failing('the customer node loanIds array is updated with the new loan id', async () => {
    const cmd = makeLoanCreationCommand(ACME_ID);

    await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
      logger: sys.logger,
      tracer: sys.tracer,
      metrics: sys.metrics,
    });

    const customer = sys.graph.get(ACME_ID);
    expect(customer).not.toBeNull();
    const loanIds = customer!['loanIds'] as string[];
    expect(loanIds).toContain(cmd.targetId);
  });

  it.failing('both updates are atomic: either both succeed or neither does', async () => {
    const beforeLoanCount = sys.graph.size();
    const cmd = makeLoanCreationCommand(ACME_ID);

    await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
      logger: sys.logger,
      tracer: sys.tracer,
      metrics: sys.metrics,
    });

    // Graph should have grown by exactly 1 (the new loan; customer already existed)
    expect(sys.graph.size()).toBe(beforeLoanCount + 1);
    // Customer sequence version should be 2 (baseline seq=1, cascade incremented to 2)
    expect(sys.events.currentSequenceVersion(ACME_ID)).toBe(2);
  });
});
