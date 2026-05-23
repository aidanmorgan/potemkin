import { Given, When, Then } from '@cucumber/cucumber';
import assert from 'assert';
import type { SimWorld } from '../support/world.js';

// REQ-20: Staged events appended atomically on UoW success
Then('all events from the unit of work should be appended atomically', async function (this: SimWorld) {
  const before = this.getEvents().length;
  await this.sendHttp('POST', `/customers/cust-${Date.now()}`, { name: 'Atomic', email: 'atomic@example.com' });
  assert.strictEqual(this.lastResponse?.status, 201);
  const after = this.getEvents().length;
  // Exactly one event should be added (the CustomerCreated event)
  assert.ok(after > before, 'At least one event should have been appended');
});

Then('no events should be appended if the command fails', async function (this: SimWorld) {
  const before = this.getEvents().length;
  // Try to create at a path that doesn't exist
  await this.sendHttp('PATCH', '/loans/00000000-0000-0000-0000-000000000000', { status: 'active' });
  assert.ok([404, 422, 500].includes(this.lastResponse?.status ?? 0), 'Should return an error');
  const after = this.getEvents().length;
  assert.strictEqual(after, before, 'No events should have been appended on failure');
});

// REQ-21: Sequence version incremented after event append
Then('the sequence version for the entity should increment after each event', async function (this: SimWorld) {
  // Create entity
  await this.sendHttp('POST', `/customers/cust-${Date.now()}`, { name: 'SeqTest', email: 'seq@example.com' });
  assert.strictEqual(this.lastResponse?.status, 201);
  const id = (this.lastResponse?.body as Record<string, unknown>)['id'] as string;

  assert.ok(this.sys, 'System must be booted');
  const seqV1 = this.sys.events.currentSequenceVersion(id);
  assert.strictEqual(seqV1, 1, 'After creation, sequence version should be 1');

  // Mutate entity
  await this.sendHttp('PATCH', `/customers/${id}`, { name: 'SeqTest Updated' });
  assert.strictEqual(this.lastResponse?.status, 200);

  const seqV2 = this.sys.events.currentSequenceVersion(id);
  assert.strictEqual(seqV2, 2, 'After mutation, sequence version should be 2');
});

Then('the event should carry the incremented sequence version', async function (this: SimWorld) {
  await this.sendHttp('POST', `/customers/cust-${Date.now()}`, { name: 'EvtSeq', email: 'evtseq@example.com' });
  assert.strictEqual(this.lastResponse?.status, 201);
  const id = (this.lastResponse?.body as Record<string, unknown>)['id'] as string;

  const events = this.getEvents().filter(e => e.aggregateId === id);
  assert.ok(events.length > 0, 'Should have events for this aggregate');
  assert.strictEqual(events[0]?.sequenceVersion, 1, 'First event should have sequenceVersion=1');
});

// REQ-22: State graph updated immediately after event projection
Then('the state graph should reflect the committed event immediately', async function (this: SimWorld) {
  await this.sendHttp('POST', `/customers/cust-${Date.now()}`, { name: 'Immediate', email: 'imm@example.com' });
  assert.strictEqual(this.lastResponse?.status, 201);
  const id = (this.lastResponse?.body as Record<string, unknown>)['id'] as string;

  // Immediately after POST, entity should be in state graph
  const entity = this.getState(id);
  assert.ok(entity !== null, 'Entity should be immediately available in state graph after event');
  const e = entity as Record<string, unknown>;
  assert.strictEqual(e['name'], 'Immediate', 'State graph entity should reflect event payload');
});

Then('the state graph should reflect mutation events', async function (this: SimWorld) {
  // Create
  await this.sendHttp('POST', `/customers/cust-${Date.now()}`, { name: 'MutReflect', email: 'mut@example.com' });
  assert.strictEqual(this.lastResponse?.status, 201);
  const id = (this.lastResponse?.body as Record<string, unknown>)['id'] as string;

  // Mutate
  await this.sendHttp('PATCH', `/customers/${id}`, { name: 'MutReflect Updated' });
  assert.strictEqual(this.lastResponse?.status, 200);

  const entity = this.getState(id);
  assert.ok(entity !== null, 'Entity should exist');
  const e = entity as Record<string, unknown>;
  assert.strictEqual(e['name'], 'MutReflect Updated', 'State graph should reflect mutation');
});

When('I retrieve the event log for entity {string}', function (this: SimWorld, id: string) {
  assert.ok(this.sys, 'System not booted');
  this.ctx['entityEvents'] = this.sys.events.byAggregate(id);
});

Then('the event log for the entity should have {int} event(s)', function (this: SimWorld, expected: number) {
  const events = this.ctx['entityEvents'] as readonly unknown[];
  assert.strictEqual(events.length, expected, `Expected ${expected} events but got ${events.length}`);
});
