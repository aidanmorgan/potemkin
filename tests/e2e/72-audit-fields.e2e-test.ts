/**
 * 72 — Automatic audit fields: updatedAt / updatedBy (engine-only).
 *
 * Demonstrates `audit_fields: true` declared on a boundary DSL file. When this
 * flag is set, the engine stamps two fields onto every non-baseline projected
 * entity after the reducer runs:
 *
 *   updatedAt — ISO-8601 timestamp copied from the event (not the wall clock)
 *   updatedBy — actor id resolved from the Authorization header, or null when
 *               the request is anonymous
 *
 * The actor is resolved by the simple-auth shortcut: with `auth.mode: simple`
 * (configured in global.yaml), any `Authorization: Bearer <id>:<scopes>` header
 * is parsed and the `<id>` portion becomes the actor id. This is the simulation
 * shortcut — no real JWT signing needed for engine-only tests.
 *
 * Fixture: tests/fixtures/audit-fields/
 *   Note boundary (/notes)          — audit_fields: true (creation)
 *   NoteById boundary (/notes/{id}) — audit_fields: true (mutation + query)
 *
 * YAML shape:
 *   audit_fields: true
 *
 * Global config (dsl/global.yaml):
 *   auth:
 *     mode: simple
 *
 * Driving an identified actor (simple-auth shortcut):
 *   fwd(engineUrl, 'POST', '/notes', body, { Authorization: 'Bearer alice:writer' })
 *   → resolves actor id = 'alice'
 */

import { startEngineOnlyApp } from './_harness/engine-only-app';
import type { EngineOnlyApp } from './_harness/engine-only-app';
import { fwd, getGraphNode } from './_harness/crm-e2e-helpers';
import type { JsonObject } from './_harness/crm-e2e-helpers';

describe('72 — Automatic audit fields: updatedAt / updatedBy (engine-only)', () => {
  let app: EngineOnlyApp;

  beforeAll(async () => {
    app = await startEngineOnlyApp({ fixtureName: 'audit-fields' });
  }, 120_000);

  afterAll(async () => {
    await app.shutdown();
  }, 30_000);

  describe('Note boundary (audit_fields: true, creation)', () => {
    it('POST /notes response carries updatedAt as a plausible ISO-8601 timestamp', async () => {
      const before = new Date().toISOString();
      const res = await fwd(
        app.engineUrl,
        'POST',
        '/notes',
        { title: 'Audit Demo', body: 'First note' },
        { Authorization: 'Bearer alice:writer' },
      );
      const after = new Date().toISOString();

      expect(res.status).toBe(201);
      const body = res.body as JsonObject;
      expect(typeof body['updatedAt']).toBe('string');
      // updatedAt must parse as a valid date and fall within the request window
      const ts = body['updatedAt'] as string;
      expect(isNaN(Date.parse(ts))).toBe(false);
      expect(ts >= before).toBe(true);
      expect(ts <= after).toBe(true);
    }, 30_000);

    it('POST /notes response carries updatedBy equal to the acting actor id', async () => {
      const res = await fwd(
        app.engineUrl,
        'POST',
        '/notes',
        { title: 'Actor Test', body: 'Note by alice' },
        { Authorization: 'Bearer alice:writer' },
      );

      expect(res.status).toBe(201);
      const body = res.body as JsonObject;
      expect(body['updatedBy']).toBe('alice');
    }, 30_000);

    it('POST /notes response carries updatedBy = null when no Authorization header is sent', async () => {
      const res = await fwd(
        app.engineUrl,
        'POST',
        '/notes',
        { title: 'Anonymous Note', body: 'No actor' },
      );

      expect(res.status).toBe(201);
      const body = res.body as JsonObject;
      expect(body['updatedBy']).toBeNull();
    }, 30_000);
  });

  describe('NoteById boundary (audit_fields: true, mutation)', () => {
    it('PATCH /notes/{id} response carries updatedBy equal to the mutating actor id', async () => {
      const createRes = await fwd(
        app.engineUrl,
        'POST',
        '/notes',
        { title: 'Original Title', body: 'Original body' },
        { Authorization: 'Bearer alice:writer' },
      );
      expect(createRes.status).toBe(201);
      const noteId = (createRes.body as JsonObject)['id'] as string;

      const patchRes = await fwd(
        app.engineUrl,
        'PATCH',
        `/notes/${noteId}`,
        { title: 'Updated Title' },
        { Authorization: 'Bearer bob:writer' },
      );

      expect(patchRes.status).toBe(200);
      const body = patchRes.body as JsonObject;
      expect(body['updatedBy']).toBe('bob');
    }, 30_000);

    it('PATCH /notes/{id} response carries updatedAt reflecting the mutation timestamp', async () => {
      const createRes = await fwd(
        app.engineUrl,
        'POST',
        '/notes',
        { title: 'Time Check', body: 'Original' },
        { Authorization: 'Bearer alice:writer' },
      );
      expect(createRes.status).toBe(201);
      const noteId = (createRes.body as JsonObject)['id'] as string;

      const before = new Date().toISOString();
      const patchRes = await fwd(
        app.engineUrl,
        'PATCH',
        `/notes/${noteId}`,
        { body: 'Updated body' },
        { Authorization: 'Bearer bob:writer' },
      );
      const after = new Date().toISOString();

      expect(patchRes.status).toBe(200);
      const body = patchRes.body as JsonObject;
      expect(typeof body['updatedAt']).toBe('string');
      const ts = body['updatedAt'] as string;
      expect(isNaN(Date.parse(ts))).toBe(false);
      expect(ts >= before).toBe(true);
      expect(ts <= after).toBe(true);
    }, 30_000);

    it('PATCH /notes/{id} updatedBy reflects the mutating actor, not the original creator', async () => {
      const createRes = await fwd(
        app.engineUrl,
        'POST',
        '/notes',
        { title: 'Ownership Test', body: 'Created by alice' },
        { Authorization: 'Bearer alice:writer' },
      );
      expect(createRes.status).toBe(201);
      const noteId = (createRes.body as JsonObject)['id'] as string;
      expect((createRes.body as JsonObject)['updatedBy']).toBe('alice');

      const patchRes = await fwd(
        app.engineUrl,
        'PATCH',
        `/notes/${noteId}`,
        { body: 'Mutated by carol' },
        { Authorization: 'Bearer carol:admin' },
      );

      expect(patchRes.status).toBe(200);
      const body = patchRes.body as JsonObject;
      // updatedBy must now reflect the mutating actor (carol), not the original creator (alice)
      expect(body['updatedBy']).toBe('carol');
    }, 30_000);

    it('graph state carries updatedAt and updatedBy after mutation', async () => {
      const createRes = await fwd(
        app.engineUrl,
        'POST',
        '/notes',
        { title: 'State Check', body: 'Initial body' },
        { Authorization: 'Bearer alice:writer' },
      );
      expect(createRes.status).toBe(201);
      const noteId = (createRes.body as JsonObject)['id'] as string;

      await fwd(
        app.engineUrl,
        'PATCH',
        `/notes/${noteId}`,
        { body: 'Mutated body' },
        { Authorization: 'Bearer dave:writer' },
      );

      const entity = await getGraphNode(app.engineUrl, noteId);
      expect(entity).not.toBeNull();
      expect(typeof entity!['updatedAt']).toBe('string');
      expect(entity!['updatedBy']).toBe('dave');
    }, 30_000);
  });
});
