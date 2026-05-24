/**
 * Integration tests for GET /_engine/fixtures.
 *
 * Boots the banking fixture (2 seeded customers; loans have no initialization)
 * and exercises the endpoint end-to-end via supertest.
 *
 * Scenarios:
 *  1. GET /_engine/fixtures returns HTTP 200.
 *  2. Response contains exactly 2 fixtures (one per seeded customer).
 *  3. Each fixture path is /customers/<seed-id>.
 *  4. Each fixture body matches what GET /customers/<id> returns through the CQRS pipeline.
 *  5. Making a state mutation (POST /loans) and calling again → fixtures don't change.
 *  6. Cache-Control header defaults to max-age=30, public.
 *  7. ETag header is non-empty and equals the body checksum.
 *  8. Two successive calls → same ETag.
 *  9. If-None-Match with current ETag → 304 Not Modified.
 * 10. engine field is 'potemkin-stateful'.
 */

import request from 'supertest';
import { bootSystem } from '../../../src/engine/boot.js';
import { createGateway } from '../../../src/http/gateway.js';
import { loadBankingFixture } from '../_helpers/inline-fixture.js';
import type { BootedSystem } from '../../../src/engine/boot.js';
import type { FixturesResponse } from '../../../src/forwarding/types.js';

const ACME_COFFEE_ID = '00000000-0000-7000-8000-000000000001';
const BETA_BUILDERS_ID = '00000000-0000-7000-8000-000000000002';

describe('GET /_engine/fixtures — integration', () => {
  let sys: BootedSystem;
  let agent: ReturnType<typeof request>;

  beforeAll(async () => {
    const fixture = await loadBankingFixture();
    sys = await bootSystem(fixture);
    const app = createGateway(sys);
    agent = request(app);
  });

  afterAll(() => {
    delete process.env['ENGINE_ROUTES_TTL_SECONDS'];
  });

  // ── 1. HTTP 200 ──────────────────────────────────────────────────────────────

  it('responds with HTTP 200', async () => {
    await agent.get('/_engine/fixtures').expect(200);
  });

  // ── 2. Exactly 2 fixtures ────────────────────────────────────────────────────

  it('returns exactly 2 fixtures (one per seeded customer)', async () => {
    const res = await agent.get('/_engine/fixtures').expect(200);
    const body = res.body as FixturesResponse;
    expect(body.fixtures).toHaveLength(2);
  });

  // ── 3. Fixture paths are /customers/<seed-id> ────────────────────────────────

  it('each fixture path is /customers/<seed-id>', async () => {
    const res = await agent.get('/_engine/fixtures').expect(200);
    const { fixtures } = res.body as FixturesResponse;

    const paths = fixtures.map((f) => f.httpRequest.path).sort();
    expect(paths).toEqual([
      `/customers/${ACME_COFFEE_ID}`,
      `/customers/${BETA_BUILDERS_ID}`,
    ].sort());
  });

  // ── 4. Fixture body matches CQRS GET result ──────────────────────────────────

  it('Acme Coffee fixture body matches direct GET /customers/<id>', async () => {
    const fixtureRes = await agent.get('/_engine/fixtures').expect(200);
    const { fixtures } = fixtureRes.body as FixturesResponse;

    const acmeFixture = fixtures.find(
      (f) => f.httpRequest.path === `/customers/${ACME_COFFEE_ID}`,
    );
    expect(acmeFixture).toBeDefined();

    const directRes = await agent
      .get(`/customers/${ACME_COFFEE_ID}`)
      .expect(200);

    expect(acmeFixture!.httpResponse.body).toEqual(directRes.body);
  });

  it('Beta Builders fixture body matches direct GET /customers/<id>', async () => {
    const fixtureRes = await agent.get('/_engine/fixtures').expect(200);
    const { fixtures } = fixtureRes.body as FixturesResponse;

    const betaFixture = fixtures.find(
      (f) => f.httpRequest.path === `/customers/${BETA_BUILDERS_ID}`,
    );
    expect(betaFixture).toBeDefined();

    const directRes = await agent
      .get(`/customers/${BETA_BUILDERS_ID}`)
      .expect(200);

    expect(betaFixture!.httpResponse.body).toEqual(directRes.body);
  });

  // ── 5. State mutations don't change fixtures ─────────────────────────────────

  it('fixtures remain unchanged after a POST /loans state mutation', async () => {
    // Capture the fixture list before mutation
    const before = await agent.get('/_engine/fixtures').expect(200);
    const beforeFixtures = (before.body as FixturesResponse).fixtures;
    const beforeChecksum = (before.body as FixturesResponse).checksum;

    // Make a state mutation — create a new loan
    await agent
      .post('/loans')
      .send({ customerId: ACME_COFFEE_ID, principal: 5000 })
      .expect(201);

    // Fixture list should be identical
    const after = await agent.get('/_engine/fixtures').expect(200);
    const afterChecksum = (after.body as FixturesResponse).checksum;

    expect(afterChecksum).toBe(beforeChecksum);
    expect((after.body as FixturesResponse).fixtures).toEqual(beforeFixtures);
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

    expect((res.body as FixturesResponse).fixtures).toHaveLength(2);
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

  // ── source metadata ──────────────────────────────────────────────────────────

  it('fixture source.boundary is Customer for all stubs', async () => {
    const res = await agent.get('/_engine/fixtures').expect(200);
    const { fixtures } = res.body as FixturesResponse;
    for (const f of fixtures) {
      expect(f.source.boundary).toBe('Customer');
    }
  });

  it('fixture source.contractPath is /customers/{id} for all stubs', async () => {
    const res = await agent.get('/_engine/fixtures').expect(200);
    const { fixtures } = res.body as FixturesResponse;
    for (const f of fixtures) {
      expect(f.source.contractPath).toBe('/customers/{id}');
    }
  });
});
