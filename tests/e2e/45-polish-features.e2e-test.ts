/**
 * 45 — Stage 6 Polish Features via full Specmatic stack.
 *
 * Verifies three additive features driven by YAML:
 *   - Webhook HMAC signing (X-Potemkin-Signature: sha256=<hex>) when
 *     `webhooks[].secret` is set in global.yaml.
 *   - Deprecation / Sunset / Link response headers on boundaries with
 *     `deprecated:` config (LeadAddNote).
 *   - Latency injection on boundaries with `latency.fixed_ms` (LeadAddNote).
 *
 * The CRM fixture YAML is the system under test; the assertions just observe
 * what flows through the engine.
 */

import { startEngineOnlyApp } from './_harness/engine-only-app';
import type { EngineOnlyApp } from './_harness/engine-only-app';
import { fwd } from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';

const AGENT_ID    = '00000000-0000-7000-8000-000000000003';
const CAMPAIGN_ID = '00000000-0000-7000-8000-000000000001';
const APEX_LEAD_ID = '00000000-0000-7000-8000-000000000010';

const WEBHOOK_SECRET = 'webhook-test-secret-do-not-use-in-prod';

describe('45 — Stage 6 Polish Features (engine-only)', () => {
  let app: EngineOnlyApp;

  beforeAll(async () => {
    app = await startEngineOnlyApp();
  }, 120_000);

  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  // ── Webhook HMAC signing ──────────────────────────────────────────────────

  describe('Webhook HMAC signing (secret in global.yaml)', () => {
    const WEBHOOK_PORT = 19876;
    let webhookServer: Server;
    let receivedRequests: Array<{
      body: string;
      parsedBody: JsonObject;
      headers: Record<string, string>;
      timestamp: number;
    }>;

    beforeAll(async () => {
      receivedRequests = [];
      const http = await import('node:http');
      webhookServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: string) => { body += chunk; });
        req.on('end', () => {
          receivedRequests.push({
            body,
            parsedBody: body ? JSON.parse(body) : {},
            headers: req.headers as Record<string, string>,
            timestamp: Date.now(),
          });
          res.writeHead(200);
          res.end('OK');
        });
      });
      await new Promise<void>((resolve, reject) => {
        webhookServer.listen(WEBHOOK_PORT, '127.0.0.1', () => resolve());
        webhookServer.on('error', reject);
      });
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => webhookServer.close(() => resolve()));
    });

    it('delivered webhook payload includes X-Potemkin-Signature with sha256=<hex>', async () => {
      receivedRequests.length = 0;

      // Drive a lead through the full lifecycle to trigger the webhook.
      const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'HMAC Test Corp', contactName: 'HT',
        phone: '+61 2 9500 0001', email: 'hmac@test.com', source: 'WEBSITE',
      });
      expect([200, 201]).toContain(createRes.status);
      const leadId = (createRes.body as JsonObject)['id'] as string;

      await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {});
      await fwd(app.engineUrl, 'POST', '/calls', {
        leadId, agentId: AGENT_ID, campaignId: CAMPAIGN_ID,
        outcome: 'INTERESTED', durationSeconds: 60,
      });
      await fwd(app.engineUrl, 'POST', `/leads/${leadId}/qualify`, {});
      await fwd(app.engineUrl, 'POST', `/leads/${leadId}/convert`, { value: 10000 });

      // Wait for the async webhook to land
      await new Promise(r => setTimeout(r, 700));

      const match = receivedRequests.find(r => r.parsedBody['leadId'] === leadId);
      expect(match).toBeDefined();
      expect(match!.headers['x-potemkin-signature']).toBeDefined();
      expect(match!.headers['x-potemkin-signature']).toMatch(/^sha256=[0-9a-f]+$/);
    }, 60_000);

    it('signature verifies against the body using the YAML secret', async () => {
      receivedRequests.length = 0;

      const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'HMAC Verify Corp', contactName: 'HV',
        phone: '+61 2 9500 0002', email: 'hmac-verify@test.com', source: 'REFERRAL',
      });
      const leadId = (createRes.body as JsonObject)['id'] as string;

      await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {});
      await fwd(app.engineUrl, 'POST', '/calls', {
        leadId, agentId: AGENT_ID, campaignId: CAMPAIGN_ID,
        outcome: 'INTERESTED', durationSeconds: 60,
      });
      await fwd(app.engineUrl, 'POST', `/leads/${leadId}/qualify`, {});
      await fwd(app.engineUrl, 'POST', `/leads/${leadId}/convert`, { value: 5000 });

      await new Promise(r => setTimeout(r, 700));

      const match = receivedRequests.find(r => r.parsedBody['leadId'] === leadId);
      expect(match).toBeDefined();

      // Compute expected HMAC over the raw delivered body.
      const expected = 'sha256=' + createHmac('sha256', WEBHOOK_SECRET)
        .update(match!.body).digest('hex');
      expect(match!.headers['x-potemkin-signature']).toBe(expected);
    }, 60_000);
  });

  // ── Deprecation headers (from lead-add-note.yaml) ─────────────────────────

  describe('Deprecation / Sunset / Link headers (LeadAddNote boundary)', () => {
    it('POST /leads/{id}/notes response includes Deprecation header from YAML', async () => {
      const res = await fwd(app.engineUrl, 'POST', `/leads/${APEX_LEAD_ID}/notes`, {
        text: 'A note for deprecation testing', author: 'Tester',
      });
      expect(res.status).toBe(200);
      // RFC 8594: the engine emits Deprecation: true for deprecated boundaries.
      expect(res.headers['deprecation']).toBe('true');
    }, 60_000);

    it('Sunset header is present with the configured date', async () => {
      const res = await fwd(app.engineUrl, 'POST', `/leads/${APEX_LEAD_ID}/notes`, {
        text: 'Sunset header test', author: 'Tester',
      });
      expect(res.status).toBe(200);
      expect(res.headers['sunset']).toBe('2025-06-01');
    }, 60_000);

    it('Link header points at the successor version', async () => {
      const res = await fwd(app.engineUrl, 'POST', `/leads/${APEX_LEAD_ID}/notes`, {
        text: 'Link header test', author: 'Tester',
      });
      expect(res.status).toBe(200);
      const link = res.headers['link'];
      expect(link).toBeDefined();
      expect(link).toContain('rel="successor-version"');
      expect(link).toContain('/v2/leads/{id}/notes');
    }, 60_000);

    it('boundaries without deprecated config have no Deprecation header', async () => {
      // GET /leads is on the Lead boundary which has no deprecated config.
      const res = await fwd(app.engineUrl, 'GET', '/leads');
      expect(res.status).toBe(200);
      expect(res.headers['deprecation']).toBeUndefined();
      expect(res.headers['sunset']).toBeUndefined();
    }, 60_000);
  });

  // ── Latency injection (LeadAddNote: fixed_ms=50) ──────────────────────────

  describe('Latency injection (LeadAddNote boundary)', () => {
    it('POST /leads/{id}/notes incurs at least the configured fixed_ms delay', async () => {
      const start = Date.now();
      const res = await fwd(app.engineUrl, 'POST', `/leads/${APEX_LEAD_ID}/notes`, {
        text: 'Latency check', author: 'Tester',
      });
      const elapsed = Date.now() - start;
      expect(res.status).toBe(200);
      // Configured fixed_ms is 50 — allow some slack for HTTP overhead but assert
      // the delay is at least the configured value.
      expect(elapsed).toBeGreaterThanOrEqual(45);
    }, 60_000);

    it('boundaries without latency config respond quickly', async () => {
      const start = Date.now();
      const res = await fwd(app.engineUrl, 'GET', `/leads/${APEX_LEAD_ID}`);
      const elapsed = Date.now() - start;
      expect(res.status).toBe(200);
      // The 50ms latency only applies to LeadAddNote; a plain GET should be
      // well under that threshold even accounting for forwarding overhead.
      expect(elapsed).toBeLessThan(500);
    }, 60_000);
  });
});
