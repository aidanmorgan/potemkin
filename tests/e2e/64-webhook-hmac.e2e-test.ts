/**
 * 64 — Outbound webhooks with HMAC signature (engine-only).
 *
 * Canonical example proving that the engine:
 *   1. fires an outbound webhook when a subscribed event is emitted;
 *   2. POST-s the payload fields declared in global.yaml (resolved via CEL);
 *   3. sets x-potemkin-signature: sha256=<hex> on the delivery, where <hex>
 *      is HMAC-SHA256(secret, rawBody) — independently verified in this test.
 *
 * Fixture: tests/fixtures/webhook-hmac/
 *   - dsl/shipment.yaml      — Shipment boundary, emits ShipmentCreated on POST
 *   - dsl/shipment-by-id.yaml — read side (GET /shipments/{id})
 *   - dsl/global.yaml        — webhook declaration with secret + payload template
 *   - openapi/shipment-api.yaml
 *
 * Receiver strategy: a node:http server binds on 127.0.0.1:19877 (same port
 * the global.yaml url literal references). Requests are accumulated in an
 * array polled by the test rather than relying on a fixed sleep.
 *
 * Signature header: x-potemkin-signature (POTEMKIN_WEBHOOK_SIGNATURE constant).
 * Header value format: sha256=<lowercase hex HMAC-SHA256>.
 * Signing input: the exact raw bytes of the delivered JSON body.
 */

import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import { createHmac } from 'node:crypto';
import { startEngineOnlyApp } from './_harness/engine-only-app';
import type { EngineOnlyApp } from './_harness/engine-only-app';
import { fwd } from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

// ── Constants ────────────────────────────────────────────────────────────────

/** Port hard-coded in dsl/global.yaml — must match. */
const RECEIVER_PORT = 19877;

/** Shared secret declared in dsl/global.yaml — used to verify the signature. */
const WEBHOOK_SECRET = 'hmac-example-secret-do-not-use-in-prod';

/** Signature header name (x-potemkin-signature per POTEMKIN_WEBHOOK_SIGNATURE). */
const SIG_HEADER = 'x-potemkin-signature';

// ── Receiver helpers ─────────────────────────────────────────────────────────

interface ReceivedRequest {
  method: string;
  headers: Record<string, string>;
  /** Raw body bytes as a UTF-8 string — used as the HMAC input. */
  rawBody: string;
  parsedBody: JsonObject;
}

function startReceiver(
  port: number,
  sink: ReceivedRequest[],
): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk: Buffer | string) => { raw += chunk.toString(); });
      req.on('end', () => {
        sink.push({
          method: req.method ?? 'POST',
          headers: req.headers as Record<string, string>,
          rawBody: raw,
          parsedBody: raw ? (JSON.parse(raw) as JsonObject) : {},
        });
        res.writeHead(200);
        res.end('OK');
      });
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function stopReceiver(server: Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * Poll `sink` until a request matching `predicate` appears, or timeout.
 * Returns the matched request or undefined when the deadline is reached.
 */
async function pollFor(
  sink: ReceivedRequest[],
  predicate: (r: ReceivedRequest) => boolean,
  timeoutMs = 3000,
  intervalMs = 50,
): Promise<ReceivedRequest | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = sink.find(predicate);
    if (found) return found;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  return undefined;
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe('64 — Outbound webhooks with HMAC signature (engine-only)', () => {
  let app: EngineOnlyApp;
  let receiver: Server;
  let receivedRequests: ReceivedRequest[];

  beforeAll(async () => {
    receivedRequests = [];
    receiver = await startReceiver(RECEIVER_PORT, receivedRequests);
    app = await startEngineOnlyApp({ fixtureName: 'webhook-hmac' });
  }, 120_000);

  afterAll(async () => {
    if (app) await app.shutdown();
    await stopReceiver(receiver);
  }, 30_000);

  beforeEach(() => {
    receivedRequests.length = 0;
  });

  // ── 1. Webhook is delivered as an HTTP POST ───────────────────────────────

  describe('Webhook delivery', () => {
    it('POST /shipments triggers an outbound webhook POST to the receiver', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/shipments', {
        trackingRef: 'TRK-001',
        destination: 'Sydney',
      });
      expect([200, 201]).toContain(res.status);
      const shipmentId = (res.body as JsonObject)['id'] as string;
      expect(shipmentId).toBeTruthy();

      const hit = await pollFor(
        receivedRequests,
        (r) => (r.parsedBody['shipmentId'] as string) === shipmentId,
      );
      expect(hit).toBeDefined();
      expect(hit!.method).toBe('POST');
    }, 60_000);
  });

  // ── 2. Payload fields match the DSL payload template ─────────────────────

  describe('Webhook payload', () => {
    it('delivered body includes shipmentId, trackingRef, and event fields', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/shipments', {
        trackingRef: 'TRK-002',
        destination: 'Melbourne',
      });
      expect([200, 201]).toContain(res.status);
      const shipmentId = (res.body as JsonObject)['id'] as string;

      const hit = await pollFor(
        receivedRequests,
        (r) => (r.parsedBody['shipmentId'] as string) === shipmentId,
      );
      expect(hit).toBeDefined();
      expect(hit!.parsedBody['shipmentId']).toBe(shipmentId);
      expect(hit!.parsedBody['trackingRef']).toBe('TRK-002');
      expect(hit!.parsedBody['event']).toBe('ShipmentCreated');
    }, 60_000);
  });

  // ── 3. Signature header is present and well-formed ────────────────────────

  describe('HMAC signature header (x-potemkin-signature)', () => {
    it('x-potemkin-signature header is present with sha256=<hex> format', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/shipments', {
        trackingRef: 'TRK-003',
        destination: 'Brisbane',
      });
      expect([200, 201]).toContain(res.status);
      const shipmentId = (res.body as JsonObject)['id'] as string;

      const hit = await pollFor(
        receivedRequests,
        (r) => (r.parsedBody['shipmentId'] as string) === shipmentId,
      );
      expect(hit).toBeDefined();
      expect(hit!.headers[SIG_HEADER]).toBeDefined();
      expect(hit!.headers[SIG_HEADER]).toMatch(/^sha256=[0-9a-f]{64}$/);
    }, 60_000);

    it('signature verifies: sha256=HMAC-SHA256(secret, rawBody) matches header value', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/shipments', {
        trackingRef: 'TRK-004',
        destination: 'Perth',
      });
      expect([200, 201]).toContain(res.status);
      const shipmentId = (res.body as JsonObject)['id'] as string;

      const hit = await pollFor(
        receivedRequests,
        (r) => (r.parsedBody['shipmentId'] as string) === shipmentId,
      );
      expect(hit).toBeDefined();

      // Independently compute the expected signature using the same algorithm
      // as src/webhooks/dispatcher.ts signWebhookBody():
      //   HMAC-SHA256(secret, rawBody).digest('hex')  prefixed with "sha256=".
      const expected =
        'sha256=' +
        createHmac('sha256', WEBHOOK_SECRET).update(hit!.rawBody).digest('hex');

      expect(hit!.headers[SIG_HEADER]).toBe(expected);
    }, 60_000);

    it('signature is stable: re-computing over the same body yields the same value', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/shipments', {
        trackingRef: 'TRK-005',
        destination: 'Adelaide',
      });
      expect([200, 201]).toContain(res.status);
      const shipmentId = (res.body as JsonObject)['id'] as string;

      const hit = await pollFor(
        receivedRequests,
        (r) => (r.parsedBody['shipmentId'] as string) === shipmentId,
      );
      expect(hit).toBeDefined();

      const sig1 =
        'sha256=' +
        createHmac('sha256', WEBHOOK_SECRET).update(hit!.rawBody).digest('hex');
      const sig2 =
        'sha256=' +
        createHmac('sha256', WEBHOOK_SECRET).update(hit!.rawBody).digest('hex');

      expect(sig1).toBe(sig2);
      expect(hit!.headers[SIG_HEADER]).toBe(sig1);
    }, 60_000);

    it('a wrong secret produces a different signature (receiver can reject forgeries)', async () => {
      const res = await fwd(app.engineUrl, 'POST', '/shipments', {
        trackingRef: 'TRK-006',
        destination: 'Canberra',
      });
      expect([200, 201]).toContain(res.status);
      const shipmentId = (res.body as JsonObject)['id'] as string;

      const hit = await pollFor(
        receivedRequests,
        (r) => (r.parsedBody['shipmentId'] as string) === shipmentId,
      );
      expect(hit).toBeDefined();

      const wrongSig =
        'sha256=' +
        createHmac('sha256', 'wrong-secret').update(hit!.rawBody).digest('hex');

      expect(hit!.headers[SIG_HEADER]).not.toBe(wrongSig);
    }, 60_000);
  });
});
