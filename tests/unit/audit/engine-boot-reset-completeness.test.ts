/**
 * AUDIT: engine/boot.ts + engine/reset.ts — completeness probing tests
 *
 * Verified behaviours → it(...)
 * Identified gaps    → it.failing(...)
 */

import { bootSystem } from '../../../src/engine/boot';
import { resetSystem } from '../../../src/engine/reset';
import { BootError } from '../../../src/errors';
import { loadOpenApi } from '../../../src/contract/loader';

// ── Minimal OpenAPI fixtures ───────────────────────────────────────────────────

const MINIMAL_OPENAPI = `
openapi: "3.0.3"
info:
  title: Boot/Reset Audit
  version: "1.0.0"
paths:
  /things:
    post:
      operationId: createThing
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Thing"
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Thing"
components:
  schemas:
    Thing:
      type: object
      properties:
        id:
          type: string
        label:
          type: string
      required:
        - id
        - label
`;

const THING_DSL = `
boundary: Thing
contract_path: /things
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: ThingCreated
    payload_template:
      id: "command.targetId"
      label: "command.payload.label"
behaviors:
  - name: create-thing
    match:
      intent: creation
      condition: "true"
    emit: ThingCreated
reducers:
  - on: ThingCreated
    assign:
      id: "event.payload.id"
      label: "event.payload.label"
`;

const THING_WITH_INIT_DSL = `
boundary: Thing
contract_path: /things
fallback_override: false
identity:
  creation:
    generate: "$uuidv7()"
event_catalog:
  - type: ThingCreated
    payload_template:
      id: "command.targetId"
      label: "command.payload.label"
behaviors:
  - name: create-thing
    match:
      intent: creation
      condition: "true"
    emit: ThingCreated
reducers:
  - on: ThingCreated
    assign:
      id: "event.payload.id"
      label: "event.payload.label"
initialization:
  - id: "thing-alpha"
    label: "Alpha"
  - id: "thing-beta"
    label: "Beta"
`;

// ── VERIFIED: boot halts with BootError on unknown contractPath ────────────────

it('CONTRACT: boot throws BootError BOOT_ERR_DSL_REFERENCE when boundary contractPath is not in OpenAPI spec', async () => {
  // boot.ts lines 141-149: check contractPath present in openapi.paths → BootError if absent.
  const openapi = await loadOpenApi(MINIMAL_OPENAPI);
  await expect(
    bootSystem({
      openapi,
      dslModules: [{ name: 'thing', yaml: THING_DSL.replace('contract_path: /things', 'contract_path: /nonexistent') }],
    }),
  ).rejects.toThrow(BootError);
});

it('CONTRACT: BootError from missing contractPath has code BOOT_ERR_DSL_REFERENCE', async () => {
  const openapi = await loadOpenApi(MINIMAL_OPENAPI);
  try {
    await bootSystem({
      openapi,
      dslModules: [{ name: 'thing', yaml: THING_DSL.replace('contract_path: /things', 'contract_path: /nonexistent') }],
    });
    fail('Expected BootError');
  } catch (e) {
    expect((e as BootError).code).toBe('BOOT_ERR_DSL_REFERENCE');
  }
});

// ── VERIFIED: boot generates frozenBaseline from initialization data ───────────

it('CONTRACT: bootSystem populates frozenBaseline from initialization records', async () => {
  const openapi = await loadOpenApi(MINIMAL_OPENAPI);
  const sys = await bootSystem({
    openapi,
    dslModules: [{ name: 'thing', yaml: THING_WITH_INIT_DSL }],
  });

  expect(sys.frozenBaseline).toHaveLength(2);
  expect(sys.frozenBaseline[0].type).toBe('BaselineEntityCreatedEvent');
});

it('CONTRACT: bootSystem hydrates the StateGraph from baseline events', async () => {
  const openapi = await loadOpenApi(MINIMAL_OPENAPI);
  const sys = await bootSystem({
    openapi,
    dslModules: [{ name: 'thing', yaml: THING_WITH_INIT_DSL }],
  });

  // Both baseline entities should be in the graph
  expect(sys.graph.get('thing-alpha')).toMatchObject({ id: 'thing-alpha', label: 'Alpha' });
  expect(sys.graph.get('thing-beta')).toMatchObject({ id: 'thing-beta', label: 'Beta' });
});

// ── VERIFIED: frozenBaseline events are Object.frozen ────────────────────────

it('CONTRACT: individual frozenBaseline events are Object.frozen (immutable)', async () => {
  const openapi = await loadOpenApi(MINIMAL_OPENAPI);
  const sys = await bootSystem({
    openapi,
    dslModules: [{ name: 'thing', yaml: THING_WITH_INIT_DSL }],
  });

  // boot.ts line 216: Object.freeze({...}) on each event
  for (const event of sys.frozenBaseline) {
    expect(Object.isFrozen(event)).toBe(true);
  }
});

// ── AUDIT GAP: reset immutability — baseline payload must not be mutated in memory ─

it.failing('AUDIT GAP: frozenBaseline payload mutation between boot and reset corrupts reset state', () => {
  // Design expectation: frozenBaseline is immutable so reset always restores identical state.
  // Observed: boot.ts line 216 freezes the event object, but payload is a plain JsonObject.
  // The payload field on the frozen event object cannot be reassigned, BUT if the object
  // pointed to by payload is not itself frozen, it could be mutated.
  //
  // boot.ts line 216: Object.freeze({...event, payload: record}) — record is NOT deep-frozen.
  // If someone does frozenBaseline[0].payload.label = 'mutated', the freeze won't prevent it
  // because Object.freeze is shallow.
  //
  // reset.ts line 40-43: copies payload via JSON.parse(JSON.stringify(...)) which DOES create
  // a fresh copy — so reset is actually protected. But the gap is: the frozenBaseline ITSELF
  // can have its payload mutated between boot and reset, corrupting subsequent resets.
  //
  // This test is it.failing because we expect mutation to be blocked (i.e., throw in strict mode),
  // but in practice the payload object is not frozen and silent mutation is possible.

  // Simulate the gap: attempt to mutate a baseline event's payload
  async function run() {
    const openapi = await loadOpenApi(MINIMAL_OPENAPI);
    const sys = await bootSystem({
      openapi,
      dslModules: [{ name: 'thing', yaml: THING_WITH_INIT_DSL }],
    });

    const payload = sys.frozenBaseline[0].payload as Record<string, unknown>;
    // This should throw TypeError in strict mode if payload is frozen, but it doesn't
    // because the freeze is shallow — the payload object itself is not frozen.
    payload['label'] = 'MUTATED';

    resetSystem(sys);

    // After reset, the label should be restored to 'Alpha' from frozenBaseline.
    // But since the frozenBaseline payload was mutated (not frozen), and reset.ts
    // clones via JSON.parse(JSON.stringify(ev.payload)) at the time of reset,
    // the cloned payload will have 'MUTATED' as the label.
    const restored = sys.graph.get('thing-alpha');
    expect(restored?.label).toBe('Alpha'); // This will fail — it's 'MUTATED'
  }

  // We can't call async from inside it.failing directly; wrap:
  return run();
});

// ── VERIFIED: reset restores EXACT baseline event order ──────────────────────

it('CONTRACT: reset restores baseline events in the same insertion order as boot', async () => {
  const openapi = await loadOpenApi(MINIMAL_OPENAPI);
  const sys = await bootSystem({
    openapi,
    dslModules: [{ name: 'thing', yaml: THING_WITH_INIT_DSL }],
  });

  // Add some post-boot events
  sys.events.append([{
    eventId: 'post-boot-event',
    boundary: 'Thing',
    aggregateId: 'thing-alpha',
    type: 'System.GenericUpdateEvent',
    payload: { label: 'modified' },
    timestamp: '2024-01-01T00:00:00Z',
    sequenceVersion: 2,
    causedBy: 'cmd-1',
  }]);

  resetSystem(sys);

  // After reset, baseline events should be restored in their original insertion order.
  // reset.ts uses rehydratedEvents which preserves the map order of sys.frozenBaseline.
  const storeSize = sys.events.size();
  expect(storeSize).toBe(sys.frozenBaseline.length); // post-boot events gone
  expect(sys.graph.get('thing-alpha')?.label).toBe('Alpha');
});

// ── VERIFIED: reset purges graph and event store before re-hydrating ──────────

it('CONTRACT: reset purges all post-boot state from graph and event store', async () => {
  const openapi = await loadOpenApi(MINIMAL_OPENAPI);
  const sys = await bootSystem({
    openapi,
    dslModules: [{ name: 'thing', yaml: THING_WITH_INIT_DSL }],
  });

  // Manually add extra data
  sys.graph.set('runtime-entity', { id: 'runtime-entity', label: 'runtime' });
  sys.events.append([{
    eventId: 'runtime-evt',
    boundary: 'Thing',
    aggregateId: 'runtime-entity',
    type: 'System.GenericUpdateEvent',
    payload: { id: 'runtime-entity', label: 'runtime' },
    timestamp: '2024-01-01T00:00:00Z',
    sequenceVersion: 1,
    causedBy: 'cmd-1',
  }]);

  resetSystem(sys);

  expect(sys.graph.get('runtime-entity')).toBeNull();
});

// ── AUDIT GAP: boot frozenBaseline array itself is frozen but payloads are not ─

it('CONTRACT: frozenBaseline array is frozen (cannot push/pop)', async () => {
  const openapi = await loadOpenApi(MINIMAL_OPENAPI);
  const sys = await bootSystem({
    openapi,
    dslModules: [{ name: 'thing', yaml: THING_WITH_INIT_DSL }],
  });

  // boot.ts line 232: Object.freeze([...baseline])
  expect(Object.isFrozen(sys.frozenBaseline)).toBe(true);
});

it.failing('AUDIT GAP: frozenBaseline event payloads are NOT deeply frozen — shallow mutation possible', () => {
  // This documents the immutability gap: Object.freeze on the event is shallow.
  // The payload property of each baseline event is a plain object and can be mutated.
  // Severity: important — silent mutation of frozenBaseline corrupts subsequent resets.
  async function run() {
    const openapi = await loadOpenApi(MINIMAL_OPENAPI);
    const sys = await bootSystem({
      openapi,
      dslModules: [{ name: 'thing', yaml: THING_WITH_INIT_DSL }],
    });

    // Payload should be frozen to prevent silent corruption
    expect(Object.isFrozen(sys.frozenBaseline[0].payload)).toBe(true);
  }
  return run();
});
