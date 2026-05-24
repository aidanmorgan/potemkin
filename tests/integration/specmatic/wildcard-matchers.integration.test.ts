/**
 * wildcard-matchers.integration.test.ts
 *
 * Tests for T2 query-parameter and header wildcard matching:
 *  - "(anyvalue)", "(any)", "(string)", "*" as matcher values
 *  - Optional header names with leading "?" prefix
 */

import request from 'supertest';
import { bootSystem } from '../../../src/engine/boot.js';
import { createGateway } from '../../../src/http/gateway.js';
import { loadBankingFixture } from '../_helpers/inline-fixture.js';
import { expectation, postExpectation } from './_helpers/specmatic-format.js';

describe('wildcard-matchers.integration', () => {
  let agent: ReturnType<typeof request>;

  beforeEach(async () => {
    const fixture = await loadBankingFixture();
    const sys = await bootSystem(fixture);
    const app = createGateway(sys);
    agent = request(app);
  });

  // ── Query parameter wildcards ───────────────────────────────────────────────

  it('query param matcher "(anyvalue)" matches any present value', async () => {
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/wc-any', query: { filter: '(anyvalue)' } },
      { status: 200, body: { id: 'wc-any', name: 'WildAny', riskBand: 'LOW' } },
    )).expect(200);

    const res = await agent.get('/customers/wc-any?filter=anything').expect(200);
    expect(res.body).toEqual({ id: 'wc-any', name: 'WildAny', riskBand: 'LOW' });
  });

  it('query param matcher "(any)" matches any present value', async () => {
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/wc-any2', query: { type: '(any)' } },
      { status: 200, body: { id: 'wc-any2', name: 'WildAny2', riskBand: 'LOW' } },
    )).expect(200);

    const res = await agent.get('/customers/wc-any2?type=PREMIUM').expect(200);
    expect(res.body).toEqual({ id: 'wc-any2', name: 'WildAny2', riskBand: 'LOW' });
  });

  it('query param matcher "(string)" matches any present value', async () => {
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/wc-str', query: { search: '(string)' } },
      { status: 200, body: { id: 'wc-str', name: 'WildStr', riskBand: 'LOW' } },
    )).expect(200);

    const res = await agent.get('/customers/wc-str?search=hello').expect(200);
    expect(res.body).toEqual({ id: 'wc-str', name: 'WildStr', riskBand: 'LOW' });
  });

  it('query param matcher "*" matches any present value', async () => {
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/wc-star', query: { page: '*' } },
      { status: 200, body: { id: 'wc-star', name: 'WildStar', riskBand: 'LOW' } },
    )).expect(200);

    const res = await agent.get('/customers/wc-star?page=42').expect(200);
    expect(res.body).toEqual({ id: 'wc-star', name: 'WildStar', riskBand: 'LOW' });
  });

  it('query param wildcard requires the key to still be PRESENT', async () => {
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/wc-absent', query: { required: '(anyvalue)' } },
      { status: 200, body: { id: 'wc-absent', name: 'WildAbsent', riskBand: 'LOW' } },
    )).expect(200);

    // Key absent → stub does NOT match → falls through to CQRS → 404
    await agent.get('/customers/wc-absent').expect(404);
  });

  it('wildcard query param does not affect non-wildcard params in same stub', async () => {
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/wc-mixed', query: { filter: '(anyvalue)', version: 'v2' } },
      { status: 200, body: { id: 'wc-mixed', name: 'WildMixed', riskBand: 'LOW' } },
    )).expect(200);

    // Both present, exact version matches → stub matched
    const match = await agent.get('/customers/wc-mixed?filter=xyz&version=v2').expect(200);
    expect(match.body.id).toBe('wc-mixed');

    // Wrong version → falls through to CQRS
    await agent.get('/customers/wc-mixed?filter=xyz&version=v1').expect(404);
  });

  // ── Header wildcards ────────────────────────────────────────────────────────

  it('header matcher "(anyvalue)" matches any present value', async () => {
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/hdr-wild', headers: { 'X-Tenant-Id': '(anyvalue)' } },
      { status: 200, body: { id: 'hdr-wild', name: 'HdrWild', riskBand: 'LOW' } },
    )).expect(200);

    const res = await agent
      .get('/customers/hdr-wild')
      .set('X-Tenant-Id', 'tenant-abc')
      .expect(200);
    expect(res.body.id).toBe('hdr-wild');
  });

  it('header matcher "*" matches any present value', async () => {
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/hdr-star', headers: { 'X-Request-Id': '*' } },
      { status: 200, body: { id: 'hdr-star', name: 'HdrStar', riskBand: 'LOW' } },
    )).expect(200);

    const res = await agent
      .get('/customers/hdr-star')
      .set('X-Request-Id', 'req-12345')
      .expect(200);
    expect(res.body.id).toBe('hdr-star');
  });

  it('header wildcard still requires the header to be PRESENT', async () => {
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/hdr-missing', headers: { 'X-Required-Header': '(anyvalue)' } },
      { status: 200, body: { id: 'hdr-missing', name: 'HdrMissing', riskBand: 'LOW' } },
    )).expect(200);

    // Header absent → stub does NOT match → falls through to CQRS → 404
    await agent.get('/customers/hdr-missing').expect(404);
  });

  // ── Optional header names (?prefix) ────────────────────────────────────────

  it('optional header "?Name" matches when header is absent', async () => {
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/opt-absent', headers: { '?X-Trace-Id': 'trace-123' } },
      { status: 200, body: { id: 'opt-absent', name: 'OptAbsent', riskBand: 'LOW' } },
    )).expect(200);

    // Header absent — optional so stub still matches
    const res = await agent.get('/customers/opt-absent').expect(200);
    expect(res.body.id).toBe('opt-absent');
  });

  it('optional header "?Name" matches when header IS present with correct value', async () => {
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/opt-present', headers: { '?X-Trace-Id': 'trace-456' } },
      { status: 200, body: { id: 'opt-present', name: 'OptPresent', riskBand: 'LOW' } },
    )).expect(200);

    const res = await agent
      .get('/customers/opt-present')
      .set('X-Trace-Id', 'trace-456')
      .expect(200);
    expect(res.body.id).toBe('opt-present');
  });

  it('optional header "?Name" does NOT match when present with WRONG value', async () => {
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/opt-wrong', headers: { '?X-Trace-Id': 'expected-value' } },
      { status: 200, body: { id: 'opt-wrong', name: 'OptWrong', riskBand: 'LOW' } },
    )).expect(200);

    // Present but wrong value → falls through to CQRS → 404
    await agent
      .get('/customers/opt-wrong')
      .set('X-Trace-Id', 'wrong-value')
      .expect(404);
  });

  it('optional header "?Name" with wildcard value matches regardless of value or absence', async () => {
    await postExpectation(agent, expectation(
      { method: 'GET', path: '/customers/opt-wild', headers: { '?X-Trace-Id': '(anyvalue)' } },
      { status: 200, body: { id: 'opt-wild', name: 'OptWild', riskBand: 'LOW' } },
    )).expect(200);

    // Absent → still matches (optional)
    const r1 = await agent.get('/customers/opt-wild').expect(200);
    expect(r1.body.id).toBe('opt-wild');
  });
});
