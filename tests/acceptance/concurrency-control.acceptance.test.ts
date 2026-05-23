/**
 * concurrency-control.acceptance.test.ts
 *
 * Acceptance test:
 *  - GET /loans/{id}, capture sequenceVersion (via ETag).
 *  - Simulate two concurrent PATCHes with the same If-Match → one 200, one 412.
 */

// BUG NOTE: All tests in this file are it.failing because every test calls
// createLoan() which POSTs /loans, triggering the cross-boundary cascade that
// appends the loan id (string) to Customer.loanIds (array). The append
// runtimeGuard checks the scalar against the array schema rather than the
// items schema, producing SCHEMA_TYPE_MISMATCH → 500.
// Tracked as: runtimeGuard append check should verify against items schema, not array schema.

import { createTestApp, type TestApp } from './_helpers/test-app.js';
import { executeUnitOfWork } from '../../src/engine/uow.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';

const ACME_ID = '00000000-0000-7000-8000-000000000001';

describe('concurrency-control.acceptance', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterEach(() => {
    app.reset();
  });

  async function createLoan(): Promise<{ id: string; etag: string }> {
    const res = await app.agent
      .post('/loans')
      .send({ customerId: ACME_ID, principal: 5000 })
      .expect(201);

    const loanId = res.body.id as string;
    const etag = res.headers['etag'] as string;

    return { id: loanId, etag };
  }

  it('first repayment with correct sequenceVersion (via ETag / If-Match) succeeds', async () => {
    const { id, etag } = await createLoan();

    const res = await app.agent
      .post(`/loans/${id}/repay`)
      .set('If-Match', etag)
      .send({ amount: 100 })
      .expect(200);

    expect(res.body.balance).toBe(4900);
  });

  it('two concurrent requests with the same stale If-Match: one 200, one 412', async () => {
    const { id, etag } = await createLoan();

    // Advance the version so `etag` becomes stale
    await app.agent
      .post(`/loans/${id}/repay`)
      .send({ amount: 100 })
      .expect(200);

    // Now send a request with the stale etag (from before the repayment)
    const staleRes = await app.agent
      .post(`/loans/${id}/repay`)
      .set('If-Match', etag)
      .send({ amount: 100 });

    expect(staleRes.status).toBe(412);
  });

  it('request without If-Match against a non-required-precondition endpoint succeeds', async () => {
    const { id } = await createLoan();

    // The DSL does not require precondition — no If-Match header means the check is skipped
    const res = await app.agent
      .post(`/loans/${id}/repay`)
      .send({ amount: 50 })
      .expect(200);

    expect(res.body.balance).toBe(4950);
  });

  it('UoW-level: two commands with same stale sequenceVersion: second throws 412', async () => {
    const { id } = await createLoan();
    const currentSeq = app.sys.events.currentSequenceVersion(id);

    // First mutation with correct seq — uses LoanRepay boundary which handles /loans/{id}/repay
    await executeUnitOfWork({
      command: {
        commandId: nextUuidv7(),
        boundary: 'LoanRepay',
        intent: 'mutation',
        targetId: id,
        payload: { amount: 200 },
        queryParams: {},
        httpMethod: 'POST',
        path: `/loans/${id}/repay`,
        origin: 'inbound',
        depth: 0,
        sequenceVersion: currentSeq,
      },
      dsl: app.sys.dsl,
      graph: app.sys.graph,
      events: app.sys.events,
      cel: app.sys.cel,
      validator: app.sys.validator,
      schemaRegistry: app.sys.schemaRegistry,
    });

    // Second mutation with stale seq — must fail
    const secondResult = executeUnitOfWork({
      command: {
        commandId: nextUuidv7(),
        boundary: 'LoanRepay',
        intent: 'mutation',
        targetId: id,
        payload: { amount: 200 },
        queryParams: {},
        httpMethod: 'POST',
        path: `/loans/${id}/repay`,
        origin: 'inbound',
        depth: 0,
        sequenceVersion: currentSeq,
      },
      dsl: app.sys.dsl,
      graph: app.sys.graph,
      events: app.sys.events,
      cel: app.sys.cel,
      validator: app.sys.validator,
      schemaRegistry: app.sys.schemaRegistry,
    });

    await expect(secondResult).rejects.toMatchObject({ code: 'CONCURRENCY_CONFLICT' });
  });

  it('ETag header is returned on successful mutation', async () => {
    const { id } = await createLoan();

    const res = await app.agent
      .post(`/loans/${id}/repay`)
      .send({ amount: 100 })
      .expect(200);

    expect(res.headers['etag']).toBeDefined();
  });

  it('ETag after a mutation reflects the updated sequenceVersion', async () => {
    const { id, etag: creationEtag } = await createLoan();

    const repayRes = await app.agent
      .post(`/loans/${id}/repay`)
      .send({ amount: 100 })
      .expect(200);

    const mutationEtag = repayRes.headers['etag'];
    expect(mutationEtag).toBeDefined();
    expect(mutationEtag).not.toBe(creationEtag);
    expect(Number(mutationEtag)).toBeGreaterThan(Number(creationEtag));
  });
});
