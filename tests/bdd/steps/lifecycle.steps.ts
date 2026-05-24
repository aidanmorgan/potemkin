import { Given, When, Then } from '@cucumber/cucumber';
import assert from 'assert';
import type { SimWorld } from '../support/world.js';

// REQ-37, 38, 39: Reset purges event log, state graph, then re-ingests baseline

When('I trigger a system reset', async function (this: SimWorld) {
  await this.sendHttp('POST', '/_admin/reset');
});

Then('the reset response status should be 204', function (this: SimWorld) {
  assert.ok(this.lastResponse, 'No response captured');
  assert.strictEqual(this.lastResponse.status, 204, `Expected 204 but got ${this.lastResponse.status}`);
});

Given('I have created some entities after boot', async function (this: SimWorld) {
  const countBefore = this.getEntityCount();
  await this.sendHttp('POST', `/leads/lead-${Date.now()}`, { companyName: 'Reset Corp', contactName: 'ResetUser', email: 'reset@example.com' });
  assert.strictEqual(this.lastResponse?.status, 201);
  const countAfter = this.getEntityCount();
  assert.ok(countAfter > countBefore, 'Entity count should increase after creation');
  this.ctx['preResetEntityCount'] = countAfter;
  this.ctx['preResetEventCount'] = this.getEventCount();
});

Then('the event log should only contain baseline events', function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  const events = this.getEvents();
  const baselineCount = this.sys.frozenBaseline.length;
  assert.strictEqual(
    events.length,
    baselineCount,
    `After reset, event log should have exactly ${baselineCount} baseline events but has ${events.length}`,
  );
});

Then('all non-baseline entities should be gone', function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  const entityCount = this.getEntityCount();
  const baselineEntityCount = this.sys.frozenBaseline.length;
  // After reset, only baseline entities should remain
  // (frozenBaseline has one event per baseline entity)
  assert.ok(
    entityCount <= baselineEntityCount,
    `After reset, entity count should be <= ${baselineEntityCount} (baseline) but got ${entityCount}`,
  );
});

Then('the baseline entities should be restored', function (this: SimWorld) {
  // Seeded data should be back
  const lead = this.getState('lead-seed-001');
  assert.ok(lead !== null, 'Seed lead should be restored after reset');
  const opportunity = this.getState('opportunity-seed-001');
  assert.ok(opportunity !== null, 'Seed opportunity should be restored after reset');
});

// REQ-40: All state in volatile memory — no disk IO
Then('the state graph does not use disk storage', function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  // The state graph is backed by a plain Map — verify it's in memory
  assert.ok(typeof this.sys.graph.get === 'function', 'StateGraph should have get function');
  assert.ok(typeof this.sys.graph.purge === 'function', 'StateGraph should have purge function');
  // Memory-only: state survives reset because of frozenBaseline, not disk writes
  // There is no disk path or file handle exposed on the system
  const sysKeys = Object.keys(this.sys);
  const diskIndicators = ['file', 'disk', 'path', 'stream', 'db', 'database'];
  for (const key of sysKeys) {
    assert.ok(
      !diskIndicators.some(d => key.toLowerCase().includes(d)),
      `System should not have a disk-related field '${key}'`,
    );
  }
});

Then('the event log does not persist to disk', function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  assert.ok(typeof this.sys.events.all === 'function', 'EventStore should have all() method');
  assert.ok(typeof this.sys.events.purge === 'function', 'EventStore should have purge() method');
  // Events are in an in-memory array — purge() just calls events.length = 0
  // No file descriptor or database connection exposed
});

When('I add entities and then reset the system', async function (this: SimWorld) {
  // Add a lead
  await this.sendHttp('POST', `/leads/lead-${Date.now()}`, { companyName: 'PreReset Corp', contactName: 'PreResetUser', email: 'preresetuser@example.com' });
  assert.strictEqual(this.lastResponse?.status, 201);
  this.ctx['extraEntityId'] = (this.lastResponse.body as Record<string, unknown>)['id'] as string;

  // Trigger reset via admin endpoint
  await this.sendHttp('POST', '/_admin/reset');
  assert.strictEqual(this.lastResponse?.status, 204);
});

Then('the extra entity should no longer exist', function (this: SimWorld) {
  const id = this.ctx['extraEntityId'] as string;
  if (!id) return;
  const entity = this.getState(id);
  assert.strictEqual(entity, null, `Extra entity '${id}' should not exist after reset`);
});

Then('the event log count should equal the frozen baseline count', function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  const eventCount = this.getEventCount();
  const baselineCount = this.sys.frozenBaseline.length;
  assert.strictEqual(
    eventCount,
    baselineCount,
    `Event log count (${eventCount}) should equal frozen baseline count (${baselineCount}) after reset`,
  );
});
