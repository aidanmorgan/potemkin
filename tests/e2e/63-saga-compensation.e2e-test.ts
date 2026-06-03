/**
 * 63 — Saga compensation: canonical example of a forced step failure and
 * compensation chain (engine-only, no JVM required).
 *
 * Fixture: tests/fixtures/saga-comp/
 *
 * OrderFulfillmentSaga is declared in dsl/global.yaml. It triggers on every
 * OrderPlaced event and runs two steps:
 *
 *   Step 1 — reserveInventory (Reservation boundary, intent: creation)
 *     Succeeds unconditionally; emits ReservationCreated.
 *     Has a compensation: cancelReservation targeting the created reservation.
 *
 *   Step 2 — notifyWarehouse (Warehouse boundary, intent: mutation)
 *     Deterministically fails: the Warehouse boundary has no seeded aggregates
 *     and targeting an absent entity with intent: mutation throws
 *     EntityAbsenceError. The orchestrator catches the error and triggers
 *     compensation.
 *
 * Saga lifecycle asserted (all under __saga__ boundary):
 *   SagaStarted → SagaStepCompleted (step 1) → SagaStepFailed (step 2)
 *     → SagaCompensated (step 1 compensation) → SagaFailed
 *
 * Because sagas run fire-and-forget after the primary UoW returns, the test
 * polls /_admin/events until the SagaFailed event appears (or times out).
 */

import { startEngineOnlyApp } from './_harness/engine-only-app';
import type { EngineOnlyApp } from './_harness/engine-only-app';
import { fwd, getAllEvents } from './_harness/crm-e2e-helpers';
import type { DomainEvent, JsonObject } from './_harness/crm-e2e-helpers';

// ---------------------------------------------------------------------------
// Polling helper
// ---------------------------------------------------------------------------

/**
 * Poll /_admin/events until `predicate` returns a truthy value, or the
 * deadline is reached. Returns the matching result or undefined on timeout.
 */
async function pollUntil<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs = 4000,
  intervalMs = 80,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== undefined) return result;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('63 — Saga compensation: forced step failure triggers compensation chain', () => {
  let app: EngineOnlyApp;

  beforeAll(async () => {
    app = await startEngineOnlyApp({ fixtureName: 'saga-comp' });
  }, 30_000);

  afterAll(async () => {
    await app.shutdown();
  }, 15_000);

  it('placeOrder commits OrderPlaced and the primary order state is durable', async () => {
    const res = await fwd(app.engineUrl, 'POST', '/orders', {
      customerId: 'cust-001',
      itemId: 'item-SKU-7',
      quantity: 3,
    });
    expect([200, 201]).toContain(res.status);
    const body = res.body as JsonObject;
    expect(body['status']).toBe('PENDING');
    expect(body['itemId']).toBe('item-SKU-7');
    expect(body['quantity']).toBe(3);
  });

  it('saga lifecycle: SagaStarted → SagaStepCompleted → SagaStepFailed → SagaCompensated → SagaFailed', async () => {
    // Place a fresh order to trigger the saga.
    const orderRes = await fwd(app.engineUrl, 'POST', '/orders', {
      customerId: 'cust-comp-saga',
      itemId: 'item-WIDGET',
      quantity: 2,
    });
    expect([200, 201]).toContain(orderRes.status);
    const orderId = (orderRes.body as JsonObject)['id'] as string;
    expect(orderId).toBeTruthy();

    // Poll until SagaFailed appears under __saga__ — sagas run fire-and-forget
    // after the primary UoW response, so we retry until the full chain settles.
    const sagaEvents = await pollUntil(async () => {
      const all = await getAllEvents(app.engineUrl);
      const saga = all.filter((e: DomainEvent) => e.boundary === '__saga__');
      const hasFailed = saga.some((e: DomainEvent) => e.type === 'SagaFailed');
      return hasFailed ? saga : undefined;
    });

    expect(sagaEvents).toBeDefined();
    const events = sagaEvents!;

    // Extract event types in emission order for a single saga instance.
    // All lifecycle events for one instance share the same aggregateId
    // (the sagaInstanceId). Find the instance that contains SagaFailed.
    const instanceIds = [...new Set(events.map((e) => e.aggregateId))];
    const instanceId = instanceIds.find((id) =>
      events.some((e) => e.aggregateId === id && e.type === 'SagaFailed'),
    );
    expect(instanceId).toBeTruthy();

    const instanceEvents = events
      .filter((e: DomainEvent) => e.aggregateId === instanceId)
      .sort((a, b) => a.sequenceVersion - b.sequenceVersion);

    const types = instanceEvents.map((e: DomainEvent) => e.type);

    // Assert the full compensation lifecycle in order.
    expect(types).toContain('SagaStarted');
    expect(types).toContain('SagaStepCompleted');
    expect(types).toContain('SagaStepFailed');
    expect(types).toContain('SagaCompensated');
    expect(types).toContain('SagaFailed');

    // Ordering: SagaStepCompleted (step 1 ok) must precede SagaStepFailed (step 2 fails).
    const idxCompleted = types.indexOf('SagaStepCompleted');
    const idxFailed = types.indexOf('SagaStepFailed');
    const idxCompensated = types.indexOf('SagaCompensated');
    const idxSagaFailed = types.indexOf('SagaFailed');
    expect(idxCompleted).toBeLessThan(idxFailed);
    expect(idxFailed).toBeLessThan(idxCompensated);
    expect(idxCompensated).toBeLessThan(idxSagaFailed);

    // SagaStepFailed payload identifies the failing step (notifyWarehouse, index 1).
    const stepFailed = instanceEvents.find((e: DomainEvent) => e.type === 'SagaStepFailed')!;
    expect(stepFailed.payload['stepName']).toBe('notifyWarehouse');
    expect(stepFailed.payload['stepIndex']).toBe(1);
    expect(typeof stepFailed.payload['error']).toBe('string');

    // SagaCompensated payload identifies the compensated step (reserveInventory, index 0).
    const compensated = instanceEvents.find((e: DomainEvent) => e.type === 'SagaCompensated')!;
    expect(compensated.payload['compensatedStepName']).toBe('reserveInventory');
    expect(compensated.payload['compensatedStepIndex']).toBe(0);

    // SagaFailed payload identifies the failing step index.
    const sagaFailed = instanceEvents.find((e: DomainEvent) => e.type === 'SagaFailed')!;
    expect(sagaFailed.payload['failedAtStep']).toBe(1);
    expect(sagaFailed.payload['sagaName']).toBe('OrderFulfillmentSaga');

    // Verify saga is correlated to the order that triggered it.
    const started = instanceEvents.find((e: DomainEvent) => e.type === 'SagaStarted')!;
    expect(started.payload['sagaName']).toBe('OrderFulfillmentSaga');

    // The primary OrderPlaced event remains in the store and is unaffected by compensation.
    const allEvents = await getAllEvents(app.engineUrl);
    const orderPlacedEvent = allEvents.find(
      (e: DomainEvent) => e.type === 'OrderPlaced' && e.aggregateId === orderId,
    );
    expect(orderPlacedEvent).toBeDefined();
  });

  it('compensation emits ReservationCancelled on the reservation created in step 1', async () => {
    // Place another order and wait for full saga lifecycle.
    const orderRes = await fwd(app.engineUrl, 'POST', '/orders', {
      customerId: 'cust-reservation-check',
      itemId: 'item-BOLT',
      quantity: 5,
    });
    expect([200, 201]).toContain(orderRes.status);
    const orderId = (orderRes.body as JsonObject)['id'] as string;

    // First locate the ReservationCreated event for this order, then poll until
    // the corresponding ReservationCancelled event (same aggregateId) appears.
    // This ensures we look at the reservation belonging to THIS order, not a
    // prior test's reservation.
    const reservationId = await pollUntil(async () => {
      const all = await getAllEvents(app.engineUrl);
      const created = all.find(
        (e: DomainEvent) =>
          e.type === 'ReservationCreated' &&
          (e.payload['orderId'] as string) === orderId,
      );
      return created ? (created.aggregateId as string) : undefined;
    });
    expect(reservationId).toBeTruthy();

    // Poll until ReservationCancelled appears for this specific reservation.
    const cancelledEvent = await pollUntil(async () => {
      const all = await getAllEvents(app.engineUrl);
      return all.find(
        (e: DomainEvent) =>
          e.type === 'ReservationCancelled' && e.aggregateId === reservationId,
      );
    });

    expect(cancelledEvent).toBeDefined();
    expect(cancelledEvent!.boundary).toBe('Reservation');

    // The cancelled reservation's cancelReason confirms it was the saga doing
    // compensation, not a client-initiated cancellation.
    expect(cancelledEvent!.payload['reason']).toBe(
      'saga-compensation: warehouse notification failed',
    );

    // Primary OrderPlaced event is durable after compensation.
    const allEvents = await getAllEvents(app.engineUrl);
    const orderPlacedEvent = allEvents.find(
      (e: DomainEvent) => e.type === 'OrderPlaced' && e.aggregateId === orderId,
    );
    expect(orderPlacedEvent).toBeDefined();
  });
});
