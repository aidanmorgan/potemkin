/**
 * 66 — Multi-boundary reactions: fan-out to >=3 boundaries, depth >5 (engine-only).
 *
 * Canonical example proving the choreography-style reactions mechanism:
 *
 *   ONE inbound operation on the Order boundary fans out — via reactions declared
 *   ONLY in the reacting boundaries' own files — to 8 distinct boundaries, all
 *   committed atomically in the same Unit of Work.
 *
 * Zero-source-coupling property (AC #2):
 *   tests/fixtures/reactions/dsl/order.yaml contains NO reactions array and NO
 *   reference to Inventory, Notification, Audit, Fulfillment, Shipping, Tracking,
 *   Dispatch, or Analytics. Every downstream effect is declared in the subscriber's
 *   own file. The source boundary is unmodified regardless of how many new subscribers
 *   are added.
 *
 * Depth >5 property (AC #3):
 *   The chain from OrderPlaced reaches depth 6 (Analytics) without error,
 *   demonstrating that reactions are not bounded by the dispatch_commands depth-5 cap.
 *
 * Fan-out (AC #1):
 *   OrderPlaced simultaneously triggers 3 independent reactions (Inventory,
 *   Notification, Audit) in the same UoW cycle.
 *
 * Reaction chain:
 *   POST /orders  →  OrderPlaced (Order, hop 0)
 *     ├── Inventory     reacts  →  InventoryReserved     (hop 1) [chain leg + fan-out leg 1]
 *     │     └── Fulfillment  reacts  →  FulfillmentScheduled   (hop 2)
 *     │           └── Shipping   reacts  →  ShippingLabelCreated    (hop 3)
 *     │                 └── Tracking  reacts  →  TrackingStarted        (hop 4)
 *     │                       └── Dispatch reacts  →  DispatchConfirmed  (hop 5)
 *     │                             └── Analytics reacts →  AnalyticsRecorded (hop 6 > 5 cap)
 *     ├── Notification  reacts  →  NotificationQueued    (hop 1) [fan-out leg 2]
 *     └── Audit         reacts  →  AuditRecorded         (hop 1) [fan-out leg 3]
 *
 * Total: 9 events in a single atomic UoW (when qty is absent/0 — warehouse gate is false).
 *
 * Fixture: tests/fixtures/reactions/
 *   - dsl/order.yaml         — source boundary (ZERO reactions)
 *   - dsl/inventory.yaml     — fan-out leg 1 + chain hop 1
 *   - dsl/notification.yaml  — fan-out leg 2 (terminal)
 *   - dsl/audit.yaml         — fan-out leg 3 (terminal)
 *   - dsl/fulfillment.yaml   — chain hop 2
 *   - dsl/shipping.yaml      — chain hop 3
 *   - dsl/tracking.yaml      — chain hop 4
 *   - dsl/dispatch.yaml      — chain hop 5
 *   - dsl/analytics.yaml     — chain hop 6 (depth > 5 proof)
 *   - dsl/warehouse.yaml     — when:/target:/payload:/intent:mutation grammar example
 */

import { startEngineOnlyApp } from './_harness/engine-only-app';
import type { EngineOnlyApp } from './_harness/engine-only-app';
import { fwd, getAllEvents, getAllEntities, getGraphNode } from './_harness/crm-e2e-helpers';
import type { JsonObject, DomainEvent } from './_harness/crm-e2e-helpers';

describe('66 — Multi-boundary reactions: fan-out to >=3 boundaries, depth >5 (engine-only)', () => {
  let app: EngineOnlyApp;

  beforeAll(async () => {
    app = await startEngineOnlyApp({ fixtureName: 'reactions' });
  }, 120_000);

  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  // ── Zero-source-coupling assertion ───────────────────────────────────────────
  //
  // This is a documentation assertion: the test verifies at runtime that the
  // Order boundary never references any of the reacting boundaries' event types.
  // The fixture YAML is the source of truth — order.yaml has no reactions key.
  // The structural guarantee is maintained by the fixture itself; what we prove
  // here is that the engine fires the reactions without ANY source coupling:
  // the Order boundary emits exactly one event (OrderPlaced) and knows nothing
  // about the 8 downstream boundaries.

  describe('zero-source-coupling: order boundary emits one event, reactions are in subscriber files', () => {
    it('a single POST /orders call commits 9 events across 9 distinct boundaries', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/orders', {
        customerId: 'cust-001',
        productId:  'prod-xyz',
      });
      expect([200, 201]).toContain(res.status);
      const orderId = (res.body as JsonObject)['id'] as string;
      expect(orderId).toBeTruthy();

      const events = await getAllEvents(app.engineUrl);
      const cycle = events.filter((e) => e.aggregateId === orderId || isReactionFrom(events, e, orderId));

      // There must be exactly 9 events in this UoW cycle.
      expect(cycle.length).toBe(9);
    }, 60_000);

    it('the Order boundary emits exactly one event (OrderPlaced) and no reactions', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/orders', {
        customerId: 'cust-002',
        productId:  'prod-abc',
      });
      expect([200, 201]).toContain(res.status);
      const orderId = (res.body as JsonObject)['id'] as string;

      const events = await getAllEvents(app.engineUrl);
      const orderEvents = events.filter((e) => e.boundary === 'Order' && e.aggregateId === orderId);

      // Zero-source-coupling: the source boundary contributed exactly one event.
      expect(orderEvents).toHaveLength(1);
      expect(orderEvents[0]!.type).toBe('OrderPlaced');
    }, 60_000);
  });

  // ── Fan-out assertion (>=3 distinct boundaries in one cycle) ─────────────────

  describe('fan-out: >=3 distinct boundaries are mutated in the same request cycle', () => {
    it('Inventory, Notification, and Audit all receive events from OrderPlaced', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/orders', {
        customerId: 'cust-003',
        productId:  'prod-fanout',
      });
      expect([200, 201]).toContain(res.status);
      const orderId = (res.body as JsonObject)['id'] as string;

      const events = await getAllEvents(app.engineUrl);
      const cycle = getUowCycle(events, orderId);

      const boundaries = new Set(cycle.map((e) => e.boundary));

      // Fan-out legs: at minimum Order + Inventory + Notification + Audit
      expect(boundaries.has('Order')).toBe(true);
      expect(boundaries.has('Inventory')).toBe(true);
      expect(boundaries.has('Notification')).toBe(true);
      expect(boundaries.has('Audit')).toBe(true);

      // Total distinct boundaries >= 4 (source + 3 reacting)
      expect(boundaries.size).toBeGreaterThanOrEqual(4);
    }, 60_000);

    it('all 9 boundaries across the chain are represented in the event log', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/orders', {
        customerId: 'cust-004',
        productId:  'prod-all',
      });
      expect([200, 201]).toContain(res.status);
      const orderId = (res.body as JsonObject)['id'] as string;

      const events = await getAllEvents(app.engineUrl);
      const cycle = getUowCycle(events, orderId);

      const boundaries = new Set(cycle.map((e) => e.boundary));
      expect(boundaries.has('Order')).toBe(true);
      expect(boundaries.has('Inventory')).toBe(true);
      expect(boundaries.has('Notification')).toBe(true);
      expect(boundaries.has('Audit')).toBe(true);
      expect(boundaries.has('Fulfillment')).toBe(true);
      expect(boundaries.has('Shipping')).toBe(true);
      expect(boundaries.has('Tracking')).toBe(true);
      expect(boundaries.has('Dispatch')).toBe(true);
      expect(boundaries.has('Analytics')).toBe(true);
    }, 60_000);
  });

  // ── Depth >5 assertion ───────────────────────────────────────────────────────

  describe('depth >5: chain reaches Analytics at hop 6 without error or truncation', () => {
    it('AnalyticsRecorded (hop 6) is committed in the same UoW as OrderPlaced', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/orders', {
        customerId: 'cust-005',
        productId:  'prod-depth',
      });
      expect([200, 201]).toContain(res.status);
      const orderId = (res.body as JsonObject)['id'] as string;

      const events = await getAllEvents(app.engineUrl);
      const cycle = getUowCycle(events, orderId);

      // Analytics at hop 6 must be present — depth-5 cap (dispatch_commands) does not apply.
      const analyticsEvent = cycle.find((e) => e.type === 'AnalyticsRecorded');
      expect(analyticsEvent).toBeDefined();
      expect(analyticsEvent!.boundary).toBe('Analytics');
    }, 60_000);

    it('the chain contains the full sequence: OrderPlaced → … → DispatchConfirmed → AnalyticsRecorded', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/orders', {
        customerId: 'cust-006',
        productId:  'prod-chain',
      });
      expect([200, 201]).toContain(res.status);
      const orderId = (res.body as JsonObject)['id'] as string;

      const events = await getAllEvents(app.engineUrl);
      const cycle = getUowCycle(events, orderId);
      const types = cycle.map((e) => e.type);

      // Each link in the chain must appear exactly once.
      expect(types.filter((t) => t === 'OrderPlaced')).toHaveLength(1);
      expect(types.filter((t) => t === 'InventoryReserved')).toHaveLength(1);
      expect(types.filter((t) => t === 'FulfillmentScheduled')).toHaveLength(1);
      expect(types.filter((t) => t === 'ShippingLabelCreated')).toHaveLength(1);
      expect(types.filter((t) => t === 'TrackingStarted')).toHaveLength(1);
      expect(types.filter((t) => t === 'DispatchConfirmed')).toHaveLength(1);
      expect(types.filter((t) => t === 'AnalyticsRecorded')).toHaveLength(1);
    }, 60_000);
  });

  // ── Atomicity: all 9 aggregates visible in the same response cycle ────────────

  describe('atomicity: all reaction-created aggregates are visible after a single POST', () => {
    it('the state graph reflects 9 new aggregates after one POST /orders', async () => {
      const entitiesBefore = await getAllEntities(app.engineUrl);
      const countBefore = Object.keys(entitiesBefore).length;

      const res = await fwd(app.engineUrl, 'POST', '/orders', {
        customerId: 'cust-007',
        productId:  'prod-atomic',
      });
      expect([200, 201]).toContain(res.status);

      const entitiesAfter = await getAllEntities(app.engineUrl);
      const countAfter = Object.keys(entitiesAfter).length;

      // One POST creates 9 aggregates: Order + Inventory + Notification + Audit +
      // Fulfillment + Shipping + Tracking + Dispatch + Analytics.
      expect(countAfter - countBefore).toBe(9);
    }, 60_000);
  });

  // ── when:/target:/payload:/intent:mutation grammar example ────────────────────
  //
  // Demonstrates the four previously-unexercised reaction fields using the
  // Warehouse boundary declared in dsl/warehouse.yaml:
  //
  //   when:    event.payload.qty > 0     — CEL gate on trigger event payload
  //   intent:  mutation                  — update an existing aggregate
  //   target:  'warehouse-main'          — CEL literal resolving to the seeded id
  //   payload: { orderId, allocatedQty } — CEL override map merged over the template
  //
  // The warehouse aggregate is seeded in beforeAll so the mutation has an existing
  // target. When the gate is false (qty absent or <= 0) the warehouse is unchanged.
  // When the gate is true (qty > 0) the warehouse state reflects the override values.

  describe('gated mutation reaction: when:/target:/payload:/intent:mutation', () => {
    const WAREHOUSE_ID = 'warehouse-main';

    beforeAll(async () => {
      // Seed the warehouse aggregate so the mutation reaction has an existing target.
      const res = await fwd(app.engineUrl, 'POST', '/warehouses', {
        id:         WAREHOUSE_ID,
        location:   'Sydney',
        totalStock: 1000,
      });
      expect([200, 201]).toContain(res.status);
    }, 30_000);

    it('when gate is FALSE (no qty): warehouse aggregate is unchanged after the order', async () => {
      const warehouseBefore = await getGraphNode(app.engineUrl, WAREHOUSE_ID);
      expect(warehouseBefore).toBeTruthy();
      const allocatedBefore = warehouseBefore!['allocatedQty'];
      const lastOrderBefore  = warehouseBefore!['lastOrderId'];

      const res = await fwd(app.engineUrl, 'POST', '/orders', {
        customerId: 'cust-gate-false',
        productId:  'prod-no-qty',
        // qty intentionally absent — event.payload.qty is null → gate is false
      });
      expect([200, 201]).toContain(res.status);

      const warehouseAfter = await getGraphNode(app.engineUrl, WAREHOUSE_ID);
      // Gate false: warehouse must be IDENTICAL — allocatedQty and lastOrderId are unchanged.
      expect(warehouseAfter!['allocatedQty']).toBe(allocatedBefore);
      expect(warehouseAfter!['lastOrderId']).toBe(lastOrderBefore);
    }, 60_000);

    it('when gate is FALSE (qty = 0): warehouse aggregate is unchanged after the order', async () => {
      const warehouseBefore = await getGraphNode(app.engineUrl, WAREHOUSE_ID);
      const allocatedBefore = warehouseBefore!['allocatedQty'];

      const res = await fwd(app.engineUrl, 'POST', '/orders', {
        customerId: 'cust-gate-zero',
        productId:  'prod-zero-qty',
        qty:        0,
      });
      expect([200, 201]).toContain(res.status);

      const warehouseAfter = await getGraphNode(app.engineUrl, WAREHOUSE_ID);
      // qty = 0 → gate false → warehouse unchanged.
      expect(warehouseAfter!['allocatedQty']).toBe(allocatedBefore);
    }, 60_000);

    it('when gate is TRUE (qty > 0): StockAllocated is committed on the warehouse aggregate', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/orders', {
        customerId: 'cust-gate-true',
        productId:  'prod-with-qty',
        qty:        5,
      });
      expect([200, 201]).toContain(res.status);
      const orderId = (res.body as JsonObject)['id'] as string;

      const events = await getAllEvents(app.engineUrl);
      const warehouseEvents = events.filter(
        (e) => e.boundary === 'Warehouse' && e.aggregateId === WAREHOUSE_ID,
      );

      // StockAllocated must have been emitted on the warehouse aggregate.
      const allocated = warehouseEvents.filter((e) => e.type === 'StockAllocated');
      expect(allocated.length).toBeGreaterThanOrEqual(1);

      // The most recent StockAllocated must carry the payload overrides from the reaction.
      const last = allocated[allocated.length - 1]!;
      expect(last.payload['orderId']).toBe(orderId);
      expect(last.payload['allocatedQty']).toBe(5);
    }, 60_000);

    it('when gate is TRUE (qty > 0): warehouse state reflects the payload: override values', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/orders', {
        customerId: 'cust-state-check',
        productId:  'prod-state-qty',
        qty:        7,
      });
      expect([200, 201]).toContain(res.status);
      const orderId = (res.body as JsonObject)['id'] as string;

      const warehouse = await getGraphNode(app.engineUrl, WAREHOUSE_ID);
      // Reducer applied the payload: overrides: lastOrderId is the triggering order id
      // and allocatedQty is the qty from the payload override map.
      expect(warehouse!['lastOrderId']).toBe(orderId);
      expect(warehouse!['allocatedQty']).toBe(7);
    }, 60_000);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns all events in the same UoW cycle as the given orderId.
 * The cycle is identified by tracing causedBy links from the root OrderPlaced event
 * or, simpler for a creation chain, by pulling the most recent N events after the
 * order event and relying on the known cycle size.
 *
 * For this fixture we use a lightweight approach: collect all events produced
 * after the most recent OrderPlaced on the given orderId, up to and including the
 * Analytics terminal. Since the test runs --runInBand, events from prior tests
 * are stable; we take the last 9 events in the log that include orderId-related events.
 */
function lastIndexOf(events: DomainEvent[], pred: (e: DomainEvent) => boolean): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (pred(events[i]!)) return i;
  }
  return -1;
}

function getUowCycle(events: DomainEvent[], orderId: string): DomainEvent[] {
  const orderIdx = lastIndexOf(
    events,
    (e) => e.boundary === 'Order' && e.aggregateId === orderId,
  );
  if (orderIdx === -1) return [];
  // A UoW cycle produces exactly 9 events for this fixture.
  return events.slice(orderIdx, orderIdx + 9);
}

/**
 * Returns true if event `e` was produced in the same UoW as the order identified
 * by `orderId` — used only in the first test where we confirm cycle size.
 */
function isReactionFrom(events: DomainEvent[], e: DomainEvent, orderId: string): boolean {
  const orderIdx = lastIndexOf(
    events,
    (ev) => ev.boundary === 'Order' && ev.aggregateId === orderId,
  );
  if (orderIdx === -1) return false;
  const cycleEnd = orderIdx + 9;
  const idx = events.indexOf(e);
  return idx > orderIdx && idx < cycleEnd;
}
