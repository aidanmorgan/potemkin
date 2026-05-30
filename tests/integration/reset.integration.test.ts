/**
 * reset.integration.test.ts
 *
 * Integration test: boot, mutate state, call resetSystem; assert:
 *  - Event log + state graph reverted byte-for-byte to post-boot baseline.
 *  - UUIDv7s of frozen baseline events are unchanged after reset.
 */

import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { executeUnitOfWork } from '../../src/engine/uow.js';
import { resetSystem } from '../../src/engine/reset.js';
import { loadFixture } from '../fixtures/index.js';
import { nextUuidv7 } from '../../src/ids/uuidv7.js';

describe('reset.integration: ephemeral reset reverts to post-boot baseline', () => {
  let sys: BootedSystem;

  // Snapshot of baseline state taken immediately after boot, before any mutations
  let baselineEventIds: string[];
  let baselineGraphEntries: Array<{ id: string; snapshot: string }>;

  beforeEach(async () => {
    const fixture = await loadFixture();
    sys = await bootSystem(fixture);

    // Capture baseline
    baselineEventIds = sys.frozenBaseline.map(e => e.eventId);
    baselineGraphEntries = sys.graph.entries().map(([id, entity]) => ({
      id,
      snapshot: JSON.stringify(entity),
    }));
  });

  async function createLead(): Promise<string> {
    const id = nextUuidv7();
    await executeUnitOfWork({
      command: {
        commandId: nextUuidv7(),
        boundary: 'Lead',
        intent: 'creation',
        targetId: id,
        payload: {
          companyName: 'Temp Lead Corp',
          contactName: 'Test User',
          phone: '+61 2 9000 9999',
          email: 'temp@test.com',
          source: 'COLD_LIST',
        },
        queryParams: {},
        httpMethod: 'POST',
        path: '/leads',
        origin: 'inbound',
        depth: 0,
      },
      dsl: sys.dsl,
      openapi: sys.openapi,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
    });
    return id;
  }

  it('event log size is restored to baseline after reset', async () => {
    const baselineSize = sys.events.size();

    await createLead();
    await createLead();

    expect(sys.events.size()).toBeGreaterThan(baselineSize);

    resetSystem(sys);

    expect(sys.events.size()).toBe(baselineSize);
  });

  it('state graph size is restored to baseline after reset', async () => {
    const baselineGraphSize = sys.graph.size();

    await createLead();
    await createLead();

    expect(sys.graph.size()).toBeGreaterThan(baselineGraphSize);

    resetSystem(sys);

    expect(sys.graph.size()).toBe(baselineGraphSize);
  });

  it('frozen baseline event IDs are identical before and after reset', async () => {
    await createLead();
    resetSystem(sys);

    const postResetIds = sys.frozenBaseline.map(e => e.eventId);
    expect(postResetIds).toEqual(baselineEventIds);
  });

  it('event log event IDs match the frozen baseline after reset', async () => {
    await createLead();
    resetSystem(sys);

    const eventLogIds = sys.events.all().map(e => e.eventId);
    expect(eventLogIds).toEqual(baselineEventIds);
  });

  it('state graph entries are identical to baseline after reset', async () => {
    await createLead();
    await createLead();

    resetSystem(sys);

    const postResetEntries = sys.graph.entries().map(([id, entity]) => ({
      id,
      snapshot: JSON.stringify(entity),
    }));

    // Sort both arrays by id before comparing to ensure stable ordering
    const sortById = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    expect(postResetEntries.sort(sortById)).toEqual(baselineGraphEntries.sort(sortById));
  });

  it('mutated entities are gone after reset', async () => {
    const leadId1 = await createLead();
    const leadId2 = await createLead();

    expect(sys.graph.get(leadId1)).not.toBeNull();
    expect(sys.graph.get(leadId2)).not.toBeNull();

    resetSystem(sys);

    expect(sys.graph.get(leadId1)).toBeNull();
    expect(sys.graph.get(leadId2)).toBeNull();
  });

  it('seeded leads are present in the state graph after reset', async () => {
    await createLead();
    resetSystem(sys);

    // Apex Solutions and BlueSky Tech are seeded leads
    expect(sys.graph.get('00000000-0000-7000-8000-000000000010')).not.toBeNull();
    expect(sys.graph.get('00000000-0000-7000-8000-000000000011')).not.toBeNull();
  });

  it('multiple resets produce identical states', async () => {
    resetSystem(sys);
    const snapshot1 = sys.events.all().map(e => e.eventId).join(',');

    resetSystem(sys);
    const snapshot2 = sys.events.all().map(e => e.eventId).join(',');

    expect(snapshot1).toBe(snapshot2);
  });
});
