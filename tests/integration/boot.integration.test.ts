/**
 * boot.integration.test.ts
 *
 * Integration test: boot end-to-end with the CRM fixture.
 * Asserts:
 *  - FrozenBaseline contains seeded entities (5 Leads + 2 Campaigns + 3 Agents).
 *  - State Graph has all seeded nodes post-boot.
 */

import { bootSystem } from '../../src/engine/boot.js';
import { loadFixture } from '../fixtures/index.js';
import { isUuidv7 } from '../../src/ids/uuidv7.js';

// Seeded entity counts: 5 Leads + 2 Campaigns + 3 Agents = 10 (Calls have no initialization)
const SEEDED_COUNT = 10;

describe('boot.integration: CRM fixture boot sequence', () => {
  it('produces a FrozenBaseline with seeded entity events', async () => {
    const fixture = await loadFixture();
    const sys = await bootSystem(fixture);

    expect(sys.frozenBaseline).toHaveLength(SEEDED_COUNT);
  });

  it('baseline events have type BaselineEntityCreatedEvent', async () => {
    const fixture = await loadFixture();
    const sys = await bootSystem(fixture);

    for (const evt of sys.frozenBaseline) {
      expect(evt.type).toBe('BaselineEntityCreatedEvent');
    }
  });

  it('baseline event IDs are valid UUIDv7 strings', async () => {
    const fixture = await loadFixture();
    const sys = await bootSystem(fixture);

    for (const evt of sys.frozenBaseline) {
      expect(isUuidv7(evt.eventId)).toBe(true);
    }
  });

  it('baseline event timestamps are anchored at epoch 0 (1970-01-01T00:00:00.000Z)', async () => {
    const fixture = await loadFixture();
    const sys = await bootSystem(fixture);

    for (const evt of sys.frozenBaseline) {
      expect(evt.timestamp).toBe('1970-01-01T00:00:00.000Z');
    }
  });

  it('state graph contains seeded nodes after boot', async () => {
    const fixture = await loadFixture();
    const sys = await bootSystem(fixture);

    expect(sys.graph.size()).toBe(SEEDED_COUNT);
  });

  it('state graph contains Apex Solutions with id 00000000-0000-7000-8000-000000000010', async () => {
    const fixture = await loadFixture();
    const sys = await bootSystem(fixture);

    const apex = sys.graph.get('00000000-0000-7000-8000-000000000010');
    expect(apex).not.toBeNull();
    expect(apex!['companyName']).toBe('Apex Solutions Ltd');
    expect(apex!['status']).toBe('NEW');
  });

  it('state graph contains BlueSky Tech with id 00000000-0000-7000-8000-000000000011', async () => {
    const fixture = await loadFixture();
    const sys = await bootSystem(fixture);

    const bluesky = sys.graph.get('00000000-0000-7000-8000-000000000011');
    expect(bluesky).not.toBeNull();
    expect(bluesky!['companyName']).toBe('BlueSky Tech');
    expect(bluesky!['status']).toBe('CONTACTED');
  });

  it('event store contains exactly seeded count of events after boot', async () => {
    const fixture = await loadFixture();
    const sys = await bootSystem(fixture);

    expect(sys.events.size()).toBe(SEEDED_COUNT);
  });

  it('frozen baseline event IDs are deterministic across multiple boots', async () => {
    const fixture1 = await loadFixture();
    const sys1 = await bootSystem(fixture1);

    const fixture2 = await loadFixture();
    const sys2 = await bootSystem(fixture2);

    const ids1 = sys1.frozenBaseline.map(e => e.eventId);
    const ids2 = sys2.frozenBaseline.map(e => e.eventId);

    expect(ids1).toEqual(ids2);
  });
});
