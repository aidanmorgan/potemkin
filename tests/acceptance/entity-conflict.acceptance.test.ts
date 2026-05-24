/**
 * entity-conflict.acceptance.test.ts
 *
 * Acceptance test: verify 409 Entity Conflict.
 *
 * Since the CRM DSL auto-generates IDs, we use:
 *  1. Direct UoW layer: try to create an entity at an already-existing seeded ID.
 *  2. Logging a call, then logging another call with the same target ID via UoW.
 */

import { createTestApp, type TestApp } from './_helpers/test-app.js';
import { executeUnitOfWork } from '../../src/engine/uow.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import { EntityConflictError } from '../../src/errors.js';

// Apex Solutions is a seeded Lead
const APEX_LEAD_ID = '00000000-0000-7000-8000-000000000010';
const AGENT_ID = '00000000-0000-7000-8000-000000000003';
const CAMPAIGN_ID = '00000000-0000-7000-8000-000000000001';

describe('entity-conflict.acceptance', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterEach(() => {
    app.reset();
  });

  it('creating a call and then re-creating with the same id via UoW throws EntityConflictError', async () => {
    // Create a call through the HTTP gateway
    const callRes = await app.agent
      .post('/calls')
      .send({
        leadId: APEX_LEAD_ID,
        agentId: AGENT_ID,
        campaignId: CAMPAIGN_ID,
        outcome: 'INTERESTED',
      })
      .expect(201);

    const callId = callRes.body.id as string;

    // Now attempt to create another entity with the SAME targetId through the UoW
    await expect(
      executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'Call',
          intent: 'creation',
          targetId: callId,
          payload: {
            leadId: APEX_LEAD_ID,
            agentId: AGENT_ID,
            campaignId: CAMPAIGN_ID,
            outcome: 'NO_ANSWER',
          },
          queryParams: {},
          httpMethod: 'POST',
          path: '/calls',
          origin: 'inbound',
          depth: 0,
        },
        dsl: app.sys.dsl,
        graph: app.sys.graph,
        events: app.sys.events,
        cel: app.sys.cel,
        validator: app.sys.validator,
        schemaRegistry: app.sys.schemaRegistry,
      }),
    ).rejects.toBeInstanceOf(EntityConflictError);
  });

  it('attempting to create a lead with the same id as a baseline lead triggers EntityConflictError in UoW', async () => {
    // APEX_LEAD_ID is already in the state graph as a Lead entity.
    // Trying to create a Lead with that id should yield EntityConflictError.
    await expect(
      executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'Lead',
          intent: 'creation',
          targetId: APEX_LEAD_ID,
          payload: {
            companyName: 'Duplicate Corp',
            contactName: 'Duplicate User',
            phone: '+61 2 9000 9999',
            email: 'dup@dup.com',
            source: 'WEBSITE',
          },
          queryParams: {},
          httpMethod: 'POST',
          path: '/leads',
          origin: 'inbound',
          depth: 0,
        },
        dsl: app.sys.dsl,
        graph: app.sys.graph,
        events: app.sys.events,
        cel: app.sys.cel,
        validator: app.sys.validator,
        schemaRegistry: app.sys.schemaRegistry,
      }),
    ).rejects.toBeInstanceOf(EntityConflictError);
  });

  it('EntityConflictError has code ENTITY_CONFLICT', async () => {
    try {
      await executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'Lead',
          intent: 'creation',
          targetId: APEX_LEAD_ID,
          payload: {
            companyName: 'Dup Corp',
            contactName: 'Dup User',
            phone: '+61 2 9000 8888',
            email: 'dup2@dup.com',
            source: 'WEBSITE',
          },
          queryParams: {},
          httpMethod: 'POST',
          path: '/leads',
          origin: 'inbound',
          depth: 0,
        },
        dsl: app.sys.dsl,
        graph: app.sys.graph,
        events: app.sys.events,
        cel: app.sys.cel,
        validator: app.sys.validator,
        schemaRegistry: app.sys.schemaRegistry,
      });
      fail('Expected EntityConflictError');
    } catch (err) {
      expect(err).toBeInstanceOf(EntityConflictError);
      expect((err as EntityConflictError).code).toBe('ENTITY_CONFLICT');
    }
  });
});
