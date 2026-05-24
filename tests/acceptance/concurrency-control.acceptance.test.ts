/**
 * concurrency-control.acceptance.test.ts
 *
 * Acceptance test:
 *  - Create a lead, capture ETag.
 *  - Simulate two concurrent mutations with the same stale If-Match → one 200, one 412.
 */

import { createTestApp, type TestApp } from './_helpers/test-app.js';
import { executeUnitOfWork } from '../../src/engine/uow.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';

const AGENT_ID = '00000000-0000-7000-8000-000000000003';
const CAMPAIGN_ID = '00000000-0000-7000-8000-000000000001';

describe('concurrency-control.acceptance', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterEach(() => {
    app.reset();
  });

  async function createLead(): Promise<{ id: string; etag: string }> {
    const res = await app.agent
      .post('/leads')
      .send({
        companyName: 'Concurrency Corp',
        contactName: 'Concurrency User',
        phone: '+61 2 9000 9999',
        email: 'concurrency@corp.com',
        source: 'WEBSITE',
      })
      .expect(201);

    const leadId = res.body.id as string;
    const etag = res.headers['etag'] as string;

    return { id: leadId, etag };
  }

  it('first contact mutation with correct sequenceVersion (via ETag / If-Match) succeeds', async () => {
    const { id, etag } = await createLead();

    const res = await app.agent
      .post(`/leads/${id}/contact`)
      .set('If-Match', etag)
      .send({})
      .expect(200);

    expect(res.body.status).toBe('CONTACTED');
  });

  it('two concurrent requests with the same stale If-Match: one 200, one 412', async () => {
    const { id, etag } = await createLead();

    // Advance the version so `etag` becomes stale
    await app.agent
      .post(`/leads/${id}/contact`)
      .send({})
      .expect(200);

    // Now send a request with the stale etag (from before the contact)
    const staleRes = await app.agent
      .post(`/leads/${id}/contact`)
      .set('If-Match', etag)
      .send({});

    expect(staleRes.status).toBe(412);
  });

  it('request without If-Match against a non-required-precondition endpoint succeeds', async () => {
    const { id } = await createLead();

    // The DSL does not require precondition for /contact — no If-Match means the check is skipped
    const res = await app.agent
      .post(`/leads/${id}/contact`)
      .send({})
      .expect(200);

    expect(res.body.status).toBe('CONTACTED');
  });

  it('UoW-level: two commands with same stale sequenceVersion: second throws 412', async () => {
    const { id } = await createLead();
    const currentSeq = app.sys.events.currentSequenceVersion(id);

    // First mutation with correct seq
    await executeUnitOfWork({
      command: {
        commandId: nextUuidv7(),
        boundary: 'Lead',
        intent: 'mutation',
        targetId: id,
        payload: { notes: 'First contact' },
        queryParams: {},
        httpMethod: 'POST',
        path: `/leads/${id}/contact`,
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
        boundary: 'Lead',
        intent: 'mutation',
        targetId: id,
        payload: { notes: 'Second contact' },
        queryParams: {},
        httpMethod: 'POST',
        path: `/leads/${id}/contact`,
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
    const { id } = await createLead();

    const res = await app.agent
      .post(`/leads/${id}/contact`)
      .send({})
      .expect(200);

    expect(res.headers['etag']).toBeDefined();
  });

  it('ETag after a mutation reflects the updated sequenceVersion', async () => {
    const { id, etag: creationEtag } = await createLead();

    const contactRes = await app.agent
      .post(`/leads/${id}/contact`)
      .send({})
      .expect(200);

    const mutationEtag = contactRes.headers['etag'];
    expect(mutationEtag).toBeDefined();
    expect(mutationEtag).not.toBe(creationEtag);
    // ETag is a quoted string per RFC 7232; strip quotes before numeric comparison.
    const stripQuotes = (s: string) => String(s).replace(/^"|"$/g, '');
    expect(Number(stripQuotes(mutationEtag))).toBeGreaterThan(Number(stripQuotes(creationEtag)));
  });
});
