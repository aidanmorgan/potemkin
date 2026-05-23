/**
 * boot.integration.test.ts
 *
 * Integration test: boot end-to-end with the banking fixture.
 * Asserts:
 *  - FrozenBaseline contains 2 customer events with epoch-anchored UUIDv7 eventIds.
 *  - State Graph has 2 customers post-boot.
 */

import { bootSystem } from '../../src/engine/boot.js';
import { loadBankingFixture } from './_helpers/inline-fixture.js';
import { isUuidv7 } from '../../src/ids/uuidv7.js';

describe('boot.integration: banking fixture boot sequence', () => {
  it('produces a FrozenBaseline with exactly 2 CustomerCreated events', async () => {
    const fixture = await loadBankingFixture();
    const sys = await bootSystem(fixture);

    expect(sys.frozenBaseline).toHaveLength(2);
  });

  it('baseline events have type BaselineEntityCreatedEvent', async () => {
    const fixture = await loadBankingFixture();
    const sys = await bootSystem(fixture);

    for (const evt of sys.frozenBaseline) {
      expect(evt.type).toBe('BaselineEntityCreatedEvent');
    }
  });

  it('baseline event IDs are valid UUIDv7 strings', async () => {
    const fixture = await loadBankingFixture();
    const sys = await bootSystem(fixture);

    for (const evt of sys.frozenBaseline) {
      expect(isUuidv7(evt.eventId)).toBe(true);
    }
  });

  it('baseline event timestamps are anchored at epoch 0 (1970-01-01T00:00:00.000Z)', async () => {
    const fixture = await loadBankingFixture();
    const sys = await bootSystem(fixture);

    // Epoch-anchored UUIDv7s must have the upper 48 bits (timestamp) set to 0.
    // We verify via the timestamp field, which boot.ts always sets to the epoch string.
    for (const evt of sys.frozenBaseline) {
      expect(evt.timestamp).toBe('1970-01-01T00:00:00.000Z');
    }
  });

  it('state graph contains 2 nodes after boot', async () => {
    const fixture = await loadBankingFixture();
    const sys = await bootSystem(fixture);

    expect(sys.graph.size()).toBe(2);
  });

  it('state graph contains Acme Coffee with id 00000000-0000-7000-8000-000000000001', async () => {
    const fixture = await loadBankingFixture();
    const sys = await bootSystem(fixture);

    const acme = sys.graph.get('00000000-0000-7000-8000-000000000001');
    expect(acme).not.toBeNull();
    expect(acme!['name']).toBe('Acme Coffee');
    expect(acme!['riskBand']).toBe('LOW');
  });

  it('state graph contains Beta Builders with id 00000000-0000-7000-8000-000000000002', async () => {
    const fixture = await loadBankingFixture();
    const sys = await bootSystem(fixture);

    const beta = sys.graph.get('00000000-0000-7000-8000-000000000002');
    expect(beta).not.toBeNull();
    expect(beta!['name']).toBe('Beta Builders');
    expect(beta!['riskBand']).toBe('MED');
  });

  it('event store contains exactly 2 events after boot', async () => {
    const fixture = await loadBankingFixture();
    const sys = await bootSystem(fixture);

    expect(sys.events.size()).toBe(2);
  });

  it('frozen baseline event IDs are deterministic across multiple boots', async () => {
    const fixture1 = await loadBankingFixture();
    const sys1 = await bootSystem(fixture1);

    const fixture2 = await loadBankingFixture();
    const sys2 = await bootSystem(fixture2);

    const ids1 = sys1.frozenBaseline.map(e => e.eventId);
    const ids2 = sys2.frozenBaseline.map(e => e.eventId);

    expect(ids1).toEqual(ids2);
  });
});
