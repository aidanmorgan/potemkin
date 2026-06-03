/**
 * 60 — Reducer patch-op examples (engine-only).
 *
 * Each describe block is the canonical illustrative example for one patch op.
 * The YAML fixtures under tests/fixtures/reducer-ops/ are the system under test;
 * this file only drives commands and asserts the projected state.
 *
 * Patch ops covered:
 *   add        — create a previously-absent field
 *   replace    — overwrite an existing field
 *   remove     — delete a field
 *   append     — push to end of array
 *   prepend    — push to front of array
 *   increment  — advance a counter by an explicit `by`
 *   merge      — shallow-merge into a nested object, preserving unmentioned keys
 *   upsert     — insert-or-replace an array element by key field
 *   copy       — copy from one pointer to another (source retained)
 *   move       — move from one pointer to another (source removed)
 *   schema_ref — runtime AJV payload validation (SCHEMA_TYPE_MISMATCH on violation)
 */

import { startEngineOnlyApp } from './_harness/engine-only-app';
import type { EngineOnlyApp } from './_harness/engine-only-app';
import { fwd, getAllEntities } from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

describe('60 — Reducer patch ops (engine-only)', () => {
  let app: EngineOnlyApp;

  beforeAll(async () => {
    app = await startEngineOnlyApp({ fixtureName: 'reducer-ops' });
  }, 120_000);

  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  // Helper: create a fresh item and return its id.
  async function createItem(name: string, initialScore = 0): Promise<string> {
    const res = await fwd(app.engineUrl, 'POST', '/items', { name, initialScore });
    expect([200, 201]).toContain(res.status);
    return (res.body as JsonObject)['id'] as string;
  }

  // Helper: read the current projected state for an item.
  async function readItem(id: string): Promise<JsonObject> {
    const entities = await getAllEntities(app.engineUrl);
    const item = entities[id];
    expect(item).toBeDefined();
    return item as JsonObject;
  }

  // ── op: add (field-creation) ──────────────────────────────────────────────

  describe('op: add — create a previously-absent field', () => {
    it('ItemCreated seeds fields that did not exist before via op:add', async () => {
      const id = await createItem('add-demo');
      const item = await readItem(id);

      // All seed fields are created by op:add in the ItemCreated reducer.
      expect(item['id']).toBe(id);
      expect(item['name']).toBe('add-demo');
      expect(item['status']).toBe('DRAFT');
      expect(item['score']).toBe(0);
      expect(item['tags']).toEqual([]);
    });

    it('addField creates /addedNote which was absent after creation', async () => {
      const id = await createItem('add-field-demo');

      // Before: addedNote is absent.
      const before = await readItem(id);
      expect(before['addedNote']).toBeUndefined();

      // Emit the event that triggers op:add on /addedNote.
      const res = await fwd(app.engineUrl, 'POST', `/items/${id}/add-field`, { note: 'hello' });
      expect(res.status).toBe(200);

      // After: addedNote is created.
      const after = await readItem(id);
      expect(after['addedNote']).toBe('hello');
    });
  });

  // ── op: replace ───────────────────────────────────────────────────────────

  describe('op: replace — overwrite an existing field', () => {
    it('renameItem overwrites /name using op:replace', async () => {
      const id = await createItem('original');

      const res = await fwd(app.engineUrl, 'POST', `/items/${id}/rename`, { name: 'renamed' });
      expect(res.status).toBe(200);

      const item = await readItem(id);
      expect(item['name']).toBe('renamed');
    });
  });

  // ── op: remove ────────────────────────────────────────────────────────────

  describe('op: remove — delete a field', () => {
    it('removeField deletes /addedNote; field is absent from projected state', async () => {
      const id = await createItem('remove-demo');

      // Seed the field.
      await fwd(app.engineUrl, 'POST', `/items/${id}/add-field`, { note: 'to-be-removed' });
      const before = await readItem(id);
      expect(before['addedNote']).toBe('to-be-removed');

      // Remove it.
      const res = await fwd(app.engineUrl, 'POST', `/items/${id}/remove-field`, {});
      expect(res.status).toBe(200);

      // Field is gone.
      const after = await readItem(id);
      expect(after['addedNote']).toBeUndefined();
    });
  });

  // ── op: append ────────────────────────────────────────────────────────────

  describe('op: append — push to end of array', () => {
    it('appendTag grows the /tags array at the tail', async () => {
      const id = await createItem('append-demo');

      await fwd(app.engineUrl, 'POST', `/items/${id}/append-tag`, { tag: 'first' });
      await fwd(app.engineUrl, 'POST', `/items/${id}/append-tag`, { tag: 'second' });

      const item = await readItem(id);
      expect(item['tags']).toEqual(['first', 'second']);
    });
  });

  // ── op: prepend ───────────────────────────────────────────────────────────

  describe('op: prepend — push to front of array', () => {
    it('prependTag inserts at index 0, after an earlier append', async () => {
      const id = await createItem('prepend-demo');

      // Append 'existing' first, so /tags = ['existing'].
      await fwd(app.engineUrl, 'POST', `/items/${id}/append-tag`, { tag: 'existing' });

      // Prepend 'pinned' — must land at index 0.
      await fwd(app.engineUrl, 'POST', `/items/${id}/prepend-tag`, { tag: 'pinned' });

      const item = await readItem(id);
      expect(item['tags']).toEqual(['pinned', 'existing']);
    });

    it('ordering: prepend then append produces [prepended, appended] (not reversed)', async () => {
      const id = await createItem('order-demo');

      await fwd(app.engineUrl, 'POST', `/items/${id}/prepend-tag`, { tag: 'front' });
      await fwd(app.engineUrl, 'POST', `/items/${id}/append-tag`, { tag: 'back' });

      const item = await readItem(id);
      const tags = item['tags'] as string[];
      expect(tags[0]).toBe('front');
      expect(tags[tags.length - 1]).toBe('back');
    });
  });

  // ── op: increment ─────────────────────────────────────────────────────────

  describe('op: increment — advance a counter with explicit `by`', () => {
    // The fixture uses `by: 5` as a literal; `by` is always a compile-time constant
    // in DSL YAML (it cannot be a CEL expression). This is the canonical usage.
    it('incrementScore advances /score by the fixture-declared step of 5', async () => {
      const id = await createItem('increment-demo', 10);

      await fwd(app.engineUrl, 'POST', `/items/${id}/increment-score`, {});
      const after1 = await readItem(id);
      expect(after1['score']).toBe(15);
    });

    it('multiple increments accumulate: score = initial + (step * calls)', async () => {
      const id = await createItem('increment-multi', 0);

      await fwd(app.engineUrl, 'POST', `/items/${id}/increment-score`, {});
      await fwd(app.engineUrl, 'POST', `/items/${id}/increment-score`, {});

      const item = await readItem(id);
      // 0 + 5 + 5 = 10
      expect(item['score']).toBe(10);
    });
  });

  // ── op: merge ─────────────────────────────────────────────────────────────

  describe('op: merge — shallow-merge into nested object, unmentioned keys preserved', () => {
    it('mergeMetadata overwrites only the supplied keys; others survive', async () => {
      const id = await createItem('merge-demo');

      // Seed /metadata with two keys.
      await fwd(app.engineUrl, 'POST', `/items/${id}/merge-metadata`, {
        changes: { source: 'manual', priority: 'high', owner: 'alice' },
      });

      // Merge a partial update — only `priority` changes; `source` and `owner` must survive.
      await fwd(app.engineUrl, 'POST', `/items/${id}/merge-metadata`, {
        changes: { priority: 'low' },
      });

      const item = await readItem(id);
      const meta = item['metadata'] as JsonObject;
      expect(meta['source']).toBe('manual');   // unmentioned — survived
      expect(meta['owner']).toBe('alice');      // unmentioned — survived
      expect(meta['priority']).toBe('low');     // mentioned — overwritten
    });
  });

  // ── op: upsert ────────────────────────────────────────────────────────────

  describe('op: upsert — insert-or-replace array element by key field', () => {
    it('first upsert inserts a new element (array grows)', async () => {
      const id = await createItem('upsert-demo');

      await fwd(app.engineUrl, 'POST', `/items/${id}/upsert-member`, {
        memberId: 'u1', role: 'viewer',
      });

      const item = await readItem(id);
      const members = item['members'] as JsonObject[];
      expect(members).toHaveLength(1);
      expect(members[0]).toEqual({ memberId: 'u1', role: 'viewer' });
    });

    it('second upsert with the same key replaces the element (array does NOT grow)', async () => {
      const id = await createItem('upsert-replace-demo');

      await fwd(app.engineUrl, 'POST', `/items/${id}/upsert-member`, {
        memberId: 'u1', role: 'viewer',
      });
      await fwd(app.engineUrl, 'POST', `/items/${id}/upsert-member`, {
        memberId: 'u1', role: 'admin',
      });

      const item = await readItem(id);
      const members = item['members'] as JsonObject[];
      // Still one element — no duplicate.
      expect(members).toHaveLength(1);
      expect(members[0]['role']).toBe('admin');
    });

    it('upsert with a different key appends a second element', async () => {
      const id = await createItem('upsert-two-demo');

      await fwd(app.engineUrl, 'POST', `/items/${id}/upsert-member`, {
        memberId: 'u1', role: 'viewer',
      });
      await fwd(app.engineUrl, 'POST', `/items/${id}/upsert-member`, {
        memberId: 'u2', role: 'editor',
      });

      const item = await readItem(id);
      const members = item['members'] as JsonObject[];
      expect(members).toHaveLength(2);
      expect(members.find((m) => m['memberId'] === 'u2')?.['role']).toBe('editor');
    });
  });

  // ── op: copy ──────────────────────────────────────────────────────────────

  describe('op: copy — copy from one pointer to another (source retained)', () => {
    it('promoteItem copies /status to /previousStatus; source /status is not removed', async () => {
      const id = await createItem('copy-demo');

      // Confirm initial status.
      const before = await readItem(id);
      expect(before['status']).toBe('DRAFT');
      expect(before['previousStatus']).toBeUndefined();

      // Promote: copy /status → /previousStatus, then set new status.
      const res = await fwd(app.engineUrl, 'POST', `/items/${id}/promote`, { newStatus: 'ACTIVE' });
      expect(res.status).toBe(200);

      const after = await readItem(id);
      // Source retained: /status now holds the NEW value.
      expect(after['status']).toBe('ACTIVE');
      // Destination created: /previousStatus holds the OLD value.
      expect(after['previousStatus']).toBe('DRAFT');
    });
  });

  // ── op: move ──────────────────────────────────────────────────────────────

  describe('op: move — move from one pointer to another (source removed)', () => {
    it('publishItem moves /draftBody to /publishedBody; source /draftBody is removed', async () => {
      const id = await createItem('move-demo');

      // Write a draft.
      const res = await fwd(app.engineUrl, 'POST', `/items/${id}/publish`, {
        draftBody: 'Hello world',
      });
      expect(res.status).toBe(200);

      const after = await readItem(id);
      // Destination created.
      expect(after['publishedBody']).toBe('Hello world');
      // Source removed.
      expect(after['draftBody']).toBeUndefined();
    });
  });

  // ── schema_ref runtime validation ─────────────────────────────────────────

  describe('schema_ref — runtime AJV payload validation', () => {
    it('conforming payload (amount is a number) projects normally', async () => {
      const id = await createItem('schema-ref-demo');

      const res = await fwd(app.engineUrl, 'POST', `/items/${id}/validate-payload`, {
        amount: 42,
        label: 'valid',
      });
      expect(res.status).toBe(200);

      const item = await readItem(id);
      const lp = item['lastPayload'] as JsonObject;
      expect(lp['amount']).toBe(42);
    });

    it('non-conforming payload (amount is a string) returns HTTP 500 with SCHEMA_TYPE_MISMATCH', async () => {
      const id = await createItem('schema-ref-bad');

      // amount must be a number; send a string to trigger schema violation.
      const res = await fwd(app.engineUrl, 'POST', `/items/${id}/validate-payload`, {
        amount: 'not-a-number',
        label: 'invalid',
      });
      expect(res.status).toBe(500);
      const body = res.body as JsonObject;
      // SCHEMA_TYPE_MISMATCH is in details.code — the HTTP layer wraps it in
      // INTERNAL_EXECUTION_ERROR but preserves the sub-code in the details object.
      const topCode = body['code'] as string | undefined;
      const detailsCode = (body['details'] as JsonObject | undefined)?.['code'];
      expect(detailsCode ?? topCode).toBe('SCHEMA_TYPE_MISMATCH');
    });
  });
});
