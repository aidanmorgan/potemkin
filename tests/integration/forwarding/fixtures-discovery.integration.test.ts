/**
 * Integration tests for GET /_engine/fixtures.
 *
 * Boots the CRM fixture (seeded Leads, Campaigns, Agents) and exercises
 * the endpoint end-to-end via supertest.
 *
 * Seeded entities with GET /{id} paths:
 *  - 5 Leads  (/leads/{id})
 *  - 2 Campaigns (/campaigns/{id})
 *  - 3 Agents (/agents/{id})
 *  Total: 10 fixtures (Calls and Opportunities have no initialization).
 *
 * Scenarios:
 *  1. GET /_engine/fixtures returns HTTP 200.
 *  2. Response contains exactly 10 fixtures.
 *  3. Fixture paths are /<boundary>/<seed-id>.
 *  4. Each fixture body matches what GET /<boundary>/<id> returns.
 *  5. Making a state mutation (POST /leads) and calling again → fixtures don't change.
 *  6. Cache-Control header defaults to max-age=30, public.
 *  7. ETag header is non-empty and equals the body checksum.
 *  8. Two successive calls → same ETag.
 *  9. If-None-Match with current ETag → 304 Not Modified.
 * 10. engine field is 'potemkin-stateful'.
 */

import type { FixturesResponse } from '../../../src/forwarding/types.js';
import { bootCrmAgent, type CrmAgent } from '../_helpers/crm-boot.js';

const APEX_LEAD_ID = '00000000-0000-7000-8000-000000000010';
const BLUESKY_LEAD_ID = '00000000-0000-7000-8000-000000000011';

describe('GET /_engine/fixtures — integration', () => {
  let agent: CrmAgent['agent'];

  beforeAll(async () => {
    const booted = await bootCrmAgent();
    agent = booted.agent;
  });

  afterAll(() => {
    delete process.env['ENGINE_ROUTES_TTL_SECONDS'];
  });

  // ── 1. HTTP 200 ──────────────────────────────────────────────────────────────

  it('responds with HTTP 200', async () => {
    await agent.get('/_engine/fixtures').expect(200);
  });

  // ── 2. Correct fixture count ─────────────────────────────────────────────────

  it('returns exactly 10 fixtures (5 Leads + 2 Campaigns + 3 Agents)', async () => {
    const res = await agent.get('/_engine/fixtures').expect(200);
    const body = res.body as FixturesResponse;
    expect(body.fixtures).toHaveLength(10);
  });

  // ── 3. Fixture paths include seeded Lead paths ────────────────────────────────

  it('fixture paths include seeded lead paths', async () => {
    const res = await agent.get('/_engine/fixtures').expect(200);
    const { fixtures } = res.body as FixturesResponse;

    const paths = fixtures.map((f) => f.httpRequest.path);
    expect(paths).toContain(`/leads/${APEX_LEAD_ID}`);
    expect(paths).toContain(`/leads/${BLUESKY_LEAD_ID}`);
  });

  // ── 4. Fixture body matches CQRS GET result ──────────────────────────────────

  it('Apex Solutions fixture body matches direct GET /leads/<id>', async () => {
    const fixtureRes = await agent.get('/_engine/fixtures').expect(200);
    const { fixtures } = fixtureRes.body as FixturesResponse;

    const apexFixture = fixtures.find(
      (f) => f.httpRequest.path === `/leads/${APEX_LEAD_ID}`,
    );
    expect(apexFixture).toBeDefined();

    const directRes = await agent
      .get(`/leads/${APEX_LEAD_ID}`)
      .expect(200);

    expect(apexFixture!.httpResponse.body).toEqual(directRes.body);
  });

  // ── 5. State mutations don't change fixtures ─────────────────────────────────

  it('fixtures remain unchanged after a POST /leads state mutation', async () => {
    // Capture the fixture list before mutation
    const before = await agent.get('/_engine/fixtures').expect(200);
    const beforeChecksum = (before.body as FixturesResponse).checksum;

    // Make a state mutation — create a new lead
    await agent
      .post('/leads')
      .send({
        companyName: 'Mutation Corp',
        contactName: 'Mutation User',
        phone: '+61 2 9000 8888',
        email: 'mutation@mutationcorp.com',
        source: 'COLD_LIST',
      })
      .expect(201);

    // Fixture list checksum should be identical (fixtures are baseline-only)
    const after = await agent.get('/_engine/fixtures').expect(200);
    const afterChecksum = (after.body as FixturesResponse).checksum;

    expect(afterChecksum).toBe(beforeChecksum);
  });

  // ── 6. Cache-Control header ───────────────────────────────────────────────────

  it('includes Cache-Control: max-age=30, public header by default', async () => {
    const res = await agent.get('/_engine/fixtures').expect(200);
    expect(res.headers['cache-control']).toBe('max-age=30, public');
  });

  // ── 7. ETag header ────────────────────────────────────────────────────────────

  it('ETag header is non-empty and matches the body checksum', async () => {
    const res = await agent.get('/_engine/fixtures').expect(200);
    const body = res.body as FixturesResponse;
    const etag = res.headers['etag'] as string;

    expect(etag).toBeTruthy();
    expect(etag).toBe(body.checksum);
  });

  // ── 8. Two successive calls → same ETag ──────────────────────────────────────

  it('returns the same ETag on two successive calls without state change', async () => {
    const res1 = await agent.get('/_engine/fixtures').expect(200);
    const res2 = await agent.get('/_engine/fixtures').expect(200);

    expect(res1.headers['etag']).toBe(res2.headers['etag']);
    expect((res1.body as FixturesResponse).checksum)
      .toBe((res2.body as FixturesResponse).checksum);
  });

  // ── 9. Conditional request → 304 ─────────────────────────────────────────────

  it('responds 304 when If-None-Match matches the current ETag', async () => {
    const first = await agent.get('/_engine/fixtures').expect(200);
    const etag = first.headers['etag'] as string;

    const second = await agent
      .get('/_engine/fixtures')
      .set('If-None-Match', etag)
      .expect(304);

    expect(second.text).toBe('');
  });

  it('responds 200 with full body when If-None-Match does not match', async () => {
    const staleEtag = 'a'.repeat(64);

    const res = await agent
      .get('/_engine/fixtures')
      .set('If-None-Match', staleEtag)
      .expect(200);

    expect((res.body as FixturesResponse).fixtures).toHaveLength(10);
  });

  // ── 10. engine field ──────────────────────────────────────────────────────────

  it('returns engine field equal to "potemkin-stateful"', async () => {
    const res = await agent.get('/_engine/fixtures').expect(200);
    expect((res.body as FixturesResponse).engine).toBe('potemkin-stateful');
  });

  // ── fixture method is always GET ──────────────────────────────────────────────

  it('all fixture stubs have method GET', async () => {
    const res = await agent.get('/_engine/fixtures').expect(200);
    const { fixtures } = res.body as FixturesResponse;
    for (const f of fixtures) {
      expect(f.httpRequest.method).toBe('GET');
    }
  });

  // ── fixture httpResponse status is 200 ───────────────────────────────────────

  it('all fixture stubs have httpResponse.status 200', async () => {
    const res = await agent.get('/_engine/fixtures').expect(200);
    const { fixtures } = res.body as FixturesResponse;
    for (const f of fixtures) {
      expect(f.httpResponse.status).toBe(200);
    }
  });
});
