/**
 * 62 — Behavior-level match.headers: header-driven behavior selection.
 *
 * Demonstrates that behaviors[].match.headers selects between two behaviors
 * bound to the SAME operationId. The fixture defines:
 *
 *   Behavior A — submitOrder.mobile
 *     match.headers: { x-channel: mobile }
 *     emit: MobileOrderPlaced → channel=mobile, priority=EXPRESS
 *
 *   Behavior B — submitOrder.default
 *     no match.headers constraint
 *     emit: OrderPlaced → channel=standard, priority=NORMAL
 *
 * Behaviors are evaluated top-to-bottom; A appears first. When the
 * x-channel: mobile header is present, A wins. When it is absent or carries
 * a different value, A is skipped and B fires — proving first-match-wins.
 *
 * Match semantics exercised (src/engine/headerMatch.ts):
 *   - Header name lookup is case-insensitive (x-channel == X-Channel).
 *   - Value comparison is exact equality ("mobile" != "MOBILE" != "web").
 *   - A missing header causes the match to fail → behavior is skipped.
 *   - AND semantics: ALL declared headers in match.headers must pass.
 *
 * Transport: engine-only (startEngineOnlyApp) — no Specmatic JVM required.
 */

import { startEngineOnlyApp } from './_harness/engine-only-app';
import type { EngineOnlyApp } from './_harness/engine-only-app';
import { fwd, getEventsByAggregate } from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

// ── Fixture ──────────────────────────────────────────────────────────────────

describe('62 — Behavior-level match.headers (engine-only)', () => {
  let app: EngineOnlyApp;

  beforeAll(async () => {
    app = await startEngineOnlyApp({ fixtureName: 'header-match' });
  }, 60_000);

  afterAll(async () => {
    await app.shutdown();
  }, 15_000);

  // ── Behavior A: x-channel: mobile selects the mobile behavior ────────────

  describe('Behavior A — x-channel: mobile fires MobileOrderPlaced', () => {
    let orderId: string;

    it('POST with x-channel: mobile returns 201 and a mobile order', async () => {
      const res = await fwd(
        app.engineUrl,
        'POST',
        '/orders',
        { productId: 'SKU-001', quantity: 2 },
        { 'x-channel': 'mobile' },
      );
      expect(res.status).toBe(201);
      const body = res.body as JsonObject;
      orderId = body['id'] as string;
      expect(orderId).toBeTruthy();
      // channel and priority are set by the MobileOrderPlaced reducer.
      expect(body['channel']).toBe('mobile');
      expect(body['priority']).toBe('EXPRESS');
    }, 30_000);

    it('the emitted event is MobileOrderPlaced (not OrderPlaced)', async () => {
      const events = await getEventsByAggregate(app.engineUrl, orderId);
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('MobileOrderPlaced');
    }, 30_000);
  });

  // ── Behavior B: no x-channel header → default behavior fires ─────────────

  describe('Behavior B — absent x-channel fires OrderPlaced (default)', () => {
    let orderId: string;

    it('POST without x-channel header returns 201 and a standard order', async () => {
      const res = await fwd(
        app.engineUrl,
        'POST',
        '/orders',
        { productId: 'SKU-002', quantity: 1 },
        // No x-channel header — behavior A skipped, behavior B fires.
      );
      expect(res.status).toBe(201);
      const body = res.body as JsonObject;
      orderId = body['id'] as string;
      expect(orderId).toBeTruthy();
      expect(body['channel']).toBe('standard');
      expect(body['priority']).toBe('NORMAL');
    }, 30_000);

    it('the emitted event is OrderPlaced (not MobileOrderPlaced)', async () => {
      const events = await getEventsByAggregate(app.engineUrl, orderId);
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('OrderPlaced');
    }, 30_000);
  });

  // ── First-match-wins ordering ─────────────────────────────────────────────

  describe('First-match-wins: behavior A is checked before B', () => {
    it('x-channel: mobile → behavior A wins (not B)', async () => {
      const res = await fwd(
        app.engineUrl,
        'POST',
        '/orders',
        { productId: 'SKU-003', quantity: 5 },
        { 'x-channel': 'mobile' },
      );
      expect(res.status).toBe(201);
      // If ordering were reversed, B (default) would win instead.
      expect((res.body as JsonObject)['priority']).toBe('EXPRESS');
    }, 30_000);

    it('x-channel: web → behavior A skipped (header mismatch), B fires', async () => {
      const res = await fwd(
        app.engineUrl,
        'POST',
        '/orders',
        { productId: 'SKU-004', quantity: 3 },
        { 'x-channel': 'web' },
      );
      expect(res.status).toBe(201);
      // 'web' != 'mobile' → A's header predicate fails → B selected.
      expect((res.body as JsonObject)['channel']).toBe('standard');
      expect((res.body as JsonObject)['priority']).toBe('NORMAL');
    }, 30_000);
  });

  // ── Case-insensitive header NAME lookup ───────────────────────────────────

  describe('Header name lookup is case-insensitive', () => {
    it('X-Channel: mobile (mixed-case name) selects the mobile behavior', async () => {
      // The harness (fwd) lowercases all header keys before forwarding — this
      // simulates the plugin contract. The header name declared in YAML is also
      // lowercased before lookup (headerMatch.ts), so X-Channel == x-channel.
      const res = await fwd(
        app.engineUrl,
        'POST',
        '/orders',
        { productId: 'SKU-005', quantity: 1 },
        { 'X-Channel': 'mobile' },
      );
      expect(res.status).toBe(201);
      expect((res.body as JsonObject)['channel']).toBe('mobile');
    }, 30_000);
  });

  // ── Value comparison is exact (case-sensitive) ────────────────────────────

  describe('Header VALUE comparison is exact / case-sensitive', () => {
    it('x-channel: MOBILE (wrong case) does NOT select the mobile behavior', async () => {
      // 'MOBILE' !== 'mobile' — exact string equality, not case-folded.
      const res = await fwd(
        app.engineUrl,
        'POST',
        '/orders',
        { productId: 'SKU-006', quantity: 1 },
        { 'x-channel': 'MOBILE' },
      );
      expect(res.status).toBe(201);
      // Behavior A skipped (value mismatch) → behavior B fires.
      expect((res.body as JsonObject)['channel']).toBe('standard');
    }, 30_000);
  });
});
