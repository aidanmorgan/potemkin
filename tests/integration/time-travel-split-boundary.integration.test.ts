/**
 * Regression: X-Potemkin-Read-At-Version must reconstruct historical state for
 * the split collection/by-id boundary architecture. The GET /leads/{id} route
 * boundary (LeadById) owns only the delete reducer; the lead's LeadCreated /
 * LeadContacted events are emitted by the Lead / LeadContact boundaries. Replay
 * must therefore project each event through its OWN emitting boundary, not the
 * single route boundary — otherwise every reducer-applied field silently drops
 * and read-at-version returns a near-empty object.
 */
import { bootCrmAgent, type CrmAgent } from './_helpers/crm-boot';
import { POTEMKIN_READ_AT_VERSION } from '../../src/http/potemkinHeaders';

type Obj = Record<string, unknown>;

describe('time-travel across split collection/by-id boundaries (regression)', () => {
  let crm: CrmAgent;
  beforeAll(async () => { crm = await bootCrmAgent(); });

  it('reads a lead AS OF an earlier version with the historical status, not an empty object', async () => {
    const lead = (await crm.agent.post('/leads').send({
      companyName: 'TT Co', contactName: 'Dana', phone: '+61 2 9000 0000',
      email: 'tt@acme.test', source: 'WEBSITE',
    }).expect(201)).body as Obj;
    const id = lead['id'] as string;
    expect(lead['status']).toBe('NEW'); // v1

    await crm.agent.post(`/leads/${id}/contact`).send({}).expect(200); // v2 -> CONTACTED

    // Latest read: CONTACTED.
    expect(((await crm.agent.get(`/leads/${id}`)).body as Obj)['status']).toBe('CONTACTED');

    // Read AS OF v1: must reconstruct the NEW state with its fields intact
    // (the bug returned only {updatedAt, updatedBy} — status undefined).
    const atV1 = (await crm.agent.get(`/leads/${id}`).set(POTEMKIN_READ_AT_VERSION, '1').expect(200)).body as Obj;
    expect(atV1['status']).toBe('NEW');
    expect(atV1['companyName']).toBe('TT Co');
    expect(atV1['email']).toBe('tt@acme.test');

    // Read AS OF v2: CONTACTED.
    const atV2 = (await crm.agent.get(`/leads/${id}`).set(POTEMKIN_READ_AT_VERSION, '2').expect(200)).body as Obj;
    expect(atV2['status']).toBe('CONTACTED');
    expect(atV2['companyName']).toBe('TT Co');
  });
});
