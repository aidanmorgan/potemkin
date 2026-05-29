/**
 * 44 — HATEOAS / hypermedia links via full Specmatic stack.
 *
 * Verifies the engine's HATEOAS feature (driven by `hateoas:` block in
 * tests/fixtures/crm/dsl/global.yaml):
 *   - Single-entity GET responses include `_links.self.href` pointing to the
 *     entity's canonical contract path.
 *   - State-dependent action links appear based on each behavior's
 *     `condition` evaluating to true against the entity state.
 *   - Behaviors with `link_name:` set are surfaced as named links
 *     (contact, qualify, convert, disqualify) only in valid states.
 *   - Pagination envelopes carry per-item _links.
 *
 * The YAML config is the single source of truth — these tests just assert.
 */

import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import { fwd, javaAvailable } from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

const describeWithJava = javaAvailable() ? describe : describe.skip;

// Seeded fixtures — their current statuses determine which action links should appear.
const APEX_LEAD_ID    = '00000000-0000-7000-8000-000000000010'; // NEW
const BLUESKY_LEAD_ID = '00000000-0000-7000-8000-000000000011'; // CONTACTED
const CORNER_LEAD_ID  = '00000000-0000-7000-8000-000000000012'; // QUALIFIED
const DELTA_LEAD_ID   = '00000000-0000-7000-8000-000000000013'; // DISQUALIFIED

interface HateoasLink { href: string; method?: string }
interface WithLinks extends JsonObject { _links: Record<string, HateoasLink> }

describeWithJava('44 — HATEOAS hypermedia links (full Specmatic stack)', () => {
  let app: E2eApp;

  beforeAll(async () => { app = await startE2eApp(); }, 120_000);
  afterAll(async () => { await app.shutdown(); }, 30_000);

  // ── Self link ─────────────────────────────────────────────────────────────

  describe('self links', () => {
    it('single-entity GET includes _links.self.href pointing at the entity', async () => {
      const res = await fwd(app.engineUrl, 'GET', `/leads/${APEX_LEAD_ID}`);
      expect(res.status).toBe(200);
      const body = res.body as WithLinks;
      expect(body['_links']).toBeDefined();
      expect(body['_links']['self']).toBeDefined();
      expect(body['_links']['self'].href).toBe(`/leads/${APEX_LEAD_ID}`);
      expect(body['_links']['self'].method).toBe('GET');
    }, 60_000);

    it('each item in a collection response carries its own _links.self', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads');
      expect(res.status).toBe(200);
      const items = res.body as WithLinks[];
      expect(Array.isArray(items)).toBe(true);
      for (const item of items) {
        expect(item['_links']).toBeDefined();
        expect(item['_links']['self'].href).toBe(`/leads/${item['id']}`);
      }
    }, 60_000);

    it('items inside a pagination envelope each carry their own _links.self', async () => {
      const res = await fwd(app.engineUrl, 'GET', '/leads', null, {}, { limit: '2' });
      expect(res.status).toBe(200);
      const env = res.body as JsonObject;
      const items = env['items'] as WithLinks[];
      expect(items.length).toBe(2);
      for (const item of items) {
        expect(item['_links']['self'].href).toBe(`/leads/${item['id']}`);
      }
    }, 60_000);
  });

  // ── State-dependent action links ──────────────────────────────────────────

  describe('state-dependent action links', () => {
    it('NEW lead surfaces a contact link but not qualify/convert', async () => {
      const res = await fwd(app.engineUrl, 'GET', `/leads/${APEX_LEAD_ID}`);
      const body = res.body as WithLinks;
      expect(body['status']).toBe('NEW');
      expect(body['_links']['contact']).toBeDefined();
      expect(body['_links']['contact'].href).toBe(`/leads/${APEX_LEAD_ID}/contact`);
      expect(body['_links']['contact'].method).toBe('POST');
      expect(body['_links']['qualify']).toBeUndefined();
      expect(body['_links']['convert']).toBeUndefined();
    }, 60_000);

    it('CONTACTED lead surfaces qualify and disqualify links (not contact)', async () => {
      const res = await fwd(app.engineUrl, 'GET', `/leads/${BLUESKY_LEAD_ID}`);
      const body = res.body as WithLinks;
      expect(body['status']).toBe('CONTACTED');
      expect(body['_links']['qualify']).toBeDefined();
      expect(body['_links']['qualify'].href).toBe(`/leads/${BLUESKY_LEAD_ID}/qualify`);
      expect(body['_links']['disqualify']).toBeDefined();
    }, 60_000);

    it('QUALIFIED lead surfaces convert and disqualify links', async () => {
      const res = await fwd(app.engineUrl, 'GET', `/leads/${CORNER_LEAD_ID}`);
      const body = res.body as WithLinks;
      expect(body['status']).toBe('QUALIFIED');
      expect(body['_links']['convert']).toBeDefined();
      expect(body['_links']['convert'].href).toBe(`/leads/${CORNER_LEAD_ID}/convert`);
      expect(body['_links']['disqualify']).toBeDefined();
    }, 60_000);

    it('DISQUALIFIED lead surfaces self + dnc but no transition actions', async () => {
      const res = await fwd(app.engineUrl, 'GET', `/leads/${DELTA_LEAD_ID}`);
      const body = res.body as WithLinks;
      expect(body['status']).toBe('DISQUALIFIED');
      expect(body['_links']['self']).toBeDefined();
      // dnc remains available (state.status != 'DNC' && state.status != 'CONVERTED')
      expect(body['_links']['dnc']).toBeDefined();
      // No further transitions
      expect(body['_links']['contact']).toBeUndefined();
      expect(body['_links']['qualify']).toBeUndefined();
      expect(body['_links']['convert']).toBeUndefined();
      expect(body['_links']['disqualify']).toBeUndefined();
    }, 60_000);
  });

  // ── State transitions reshape the link set ────────────────────────────────

  describe('state transitions reshape the available links', () => {
    it('contacting a NEW lead replaces contact with qualify/disqualify', async () => {
      // Create a fresh lead so we don't depend on seeded fixture order.
      const createRes = await fwd(app.engineUrl, 'POST', '/leads', {
        companyName: 'HATEOAS Transition Corp', contactName: 'HT',
        phone: '+61 2 9100 4001', email: 'hateoas-trans@test.com', source: 'WEBSITE',
      });
      expect([200, 201]).toContain(createRes.status);
      const leadId = (createRes.body as JsonObject)['id'] as string;

      const before = await fwd(app.engineUrl, 'GET', `/leads/${leadId}`);
      const linksBefore = (before.body as WithLinks)['_links'];
      expect(linksBefore['contact']).toBeDefined();
      expect(linksBefore['qualify']).toBeUndefined();

      await fwd(app.engineUrl, 'POST', `/leads/${leadId}/contact`, {});

      const after = await fwd(app.engineUrl, 'GET', `/leads/${leadId}`);
      const linksAfter = (after.body as WithLinks)['_links'];
      expect(linksAfter['qualify']).toBeDefined();
      expect(linksAfter['disqualify']).toBeDefined();
      // contactLead in lead-contact.yaml declares link_condition: "state.status == 'NEW'"
      // — the runtime emit_when still allows re-contact, but the HATEOAS link
      // disappears once the lead has been contacted.
      expect(linksAfter['contact']).toBeUndefined();
    }, 60_000);
  });
});
