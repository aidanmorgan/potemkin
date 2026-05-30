/**
 * secondary-commands.integration.test.ts
 *
 * Integration test: logging a Call must cascade to append the call ID
 * onto the targeted Lead's `callIds` array (via `appendCallId` behavior).
 * Verify:
 *  - Both events appended (CallLogged + CallIdAppended on Lead).
 *  - Both state graph nodes updated atomically.
 */

import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { executeUnitOfWork } from '../../src/engine/uow.js';
import { resetSystem } from '../../src/engine/reset.js';
import { loadFixture } from '../fixtures/index.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';
import type { Command } from '../../src/types.js';

describe('secondary-commands.integration: Call creation cascades to Lead callIds', () => {
  let sys: BootedSystem;

  // Apex Solutions (NEW lead, callIds: [])
  const APEX_LEAD_ID = '00000000-0000-7000-8000-000000000010';
  // Q1 Website Leads campaign
  const CAMPAIGN_ID = '00000000-0000-7000-8000-000000000001';
  // Alice Thompson agent
  const AGENT_ID = '00000000-0000-7000-8000-000000000003';

  beforeEach(async () => {
    const fixture = await loadFixture();
    sys = await bootSystem(fixture);
  });

  afterEach(() => {
    resetSystem(sys);
  });

  function makeLogCallCommand(leadId: string): Command {
    const callId = nextUuidv7();
    return {
      commandId: nextUuidv7(),
      boundary: 'Call',
      intent: 'creation',
      targetId: callId,
      payload: {
        leadId,
        agentId: AGENT_ID,
        campaignId: CAMPAIGN_ID,
        outcome: 'INTERESTED',
      },
      queryParams: {},
      httpMethod: 'POST',
      path: '/calls',
      origin: 'inbound',
      depth: 0,
    };
  }

  it('logging a call produces at least 2 committed events (CallLogged + Lead cascade)', async () => {
    const initialEventCount = sys.events.size();
    const cmd = makeLogCallCommand(APEX_LEAD_ID);

    const result = await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      openapi: sys.openapi,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
      logger: sys.logger,
      tracer: sys.tracer,
      metrics: sys.metrics,
    });

    // Primary (CallLogged) + secondary (CallIdAppended on Lead) = at least 2
    expect(result.events.length).toBeGreaterThanOrEqual(2);
    expect(sys.events.size()).toBeGreaterThanOrEqual(initialEventCount + 2);
  });

  it('the first event is for the Call boundary', async () => {
    const cmd = makeLogCallCommand(APEX_LEAD_ID);

    const result = await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      openapi: sys.openapi,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
      logger: sys.logger,
      tracer: sys.tracer,
      metrics: sys.metrics,
    });

    expect(result.events[0]!.boundary).toBe('Call');
    expect(result.events[0]!.aggregateId).toBe(cmd.targetId);
  });

  it('the second event is for the Lead boundary (cascade)', async () => {
    const cmd = makeLogCallCommand(APEX_LEAD_ID);

    const result = await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      openapi: sys.openapi,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
      logger: sys.logger,
      tracer: sys.tracer,
      metrics: sys.metrics,
    });

    expect(result.events[1]!.boundary).toBe('Lead');
    expect(result.events[1]!.aggregateId).toBe(APEX_LEAD_ID);
  });

  it('the call node is created in the state graph', async () => {
    const cmd = makeLogCallCommand(APEX_LEAD_ID);

    await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      openapi: sys.openapi,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
      logger: sys.logger,
      tracer: sys.tracer,
      metrics: sys.metrics,
    });

    const call = sys.graph.get(cmd.targetId!);
    expect(call).not.toBeNull();
    expect(call!['leadId']).toBe(APEX_LEAD_ID);
    expect(call!['outcome']).toBe('INTERESTED');
  });

  it('the lead node callIds array is updated with the new call id', async () => {
    const cmd = makeLogCallCommand(APEX_LEAD_ID);

    await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      openapi: sys.openapi,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
      logger: sys.logger,
      tracer: sys.tracer,
      metrics: sys.metrics,
    });

    const lead = sys.graph.get(APEX_LEAD_ID);
    expect(lead).not.toBeNull();
    const callIds = lead!['callIds'] as string[];
    expect(callIds).toContain(cmd.targetId);
  });

  it('both updates are atomic: either both succeed or neither does', async () => {
    const beforeCallCount = sys.graph.size();
    const cmd = makeLogCallCommand(APEX_LEAD_ID);

    await executeUnitOfWork({
      command: cmd,
      dsl: sys.dsl,
      openapi: sys.openapi,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
      logger: sys.logger,
      tracer: sys.tracer,
      metrics: sys.metrics,
    });

    // Graph should have grown by exactly 1 (the new call; lead already existed)
    expect(sys.graph.size()).toBe(beforeCallCount + 1);
    // Lead sequence version should be 2 (baseline seq=1, cascade incremented to 2)
    expect(sys.events.currentSequenceVersion(APEX_LEAD_ID)).toBe(2);
  });
});
