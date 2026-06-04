/**
 * RED TEAM: Gateway <-> /_engine/forward parity for static boundary `mask:`
 * when a masked field is ABSENT on the stored entity, plus the cross-language
 * consequence on the Kotlin plugin's strict PatchApplier.
 *
 * THE ATTACK
 * ----------
 * The TS engine applies static response mutations (boundary `mask:` removes,
 * HATEOAS `_links` merges) through `applyResponseMutations` with
 * `{ autoVivify: true }` (src/http/responseMutations.ts:74,79). Under autoVivify
 * a `remove` of a field that does NOT exist on the body is a silent NO-OP
 * (src/dsl/patches.ts:259-262).
 *
 * - GATEWAY path: applies `mutation.body` inline, so the absent-field remove is
 *   harmlessly skipped and the genuinely-present sensitive fields are stripped.
 *
 * - FORWARDING path: returns `body = BASE` plus `_patches` (the journal of mask
 *   removes), for the Kotlin plugin to re-apply. CRITICALLY, the journal records
 *   EVERY patch including the no-op remove of the absent field
 *   (src/dsl/patches.ts:472 pushes unconditionally). So `_patches` contains a
 *   `{op:'remove', path:'/<absentField>'}` that was a no-op on the engine.
 *
 * - PLUGIN: PotemkinResponseInterceptor calls `PatchApplier.apply(bodyMap, patches)`
 *   with the DEFAULT autoVivify=false (PotemkinResponseInterceptor.kt:89). In
 *   strict mode a `remove` of an absent target THROWS PatchApplyException
 *   (PatchApplier.kt:229-235). The interceptor CATCHES that and PRESERVES THE
 *   ORIGINAL UNMASKED BODY + attaches a Warning header
 *   (PotemkinResponseInterceptor.kt:91-100).
 *
 * IMPORTANT — TWO PLUGIN APPLIERS, DIFFERENT autoVivify:
 *   - CqrsBackendClient.serialiseBodyWithPatches (CqrsBackendClient.kt:193) applies
 *     forwarded `_patches` with autoVivify=TRUE — this is the LIVE forward path
 *     (StatefulRequestHandler responses; Specmatic does NOT run ResponseInterceptors
 *     on RequestHandler output). With autoVivify=true the absent-field remove is a
 *     no-op, so the LIVE forward path MATCHES the gateway. No live divergence here.
 *   - PotemkinResponseInterceptor.applyResponsePatches (interceptor.kt:89) applies
 *     with autoVivify=FALSE (default). That applier only runs on Specmatic-stub
 *     bodies, which never carry engine `_patches` — so its strict-mode leak is
 *     LATENT (unreachable on current paths) but a real trap: the two appliers
 *     handle identical engine `_patches` with OPPOSITE autoVivify settings.
 *
 * This test proves the TS side directly (gateway masks; the forward envelope ships
 * BASE+_patches with a no-op remove for the absent field) and documents the exact
 * wire bytes. The companion Kotlin tests in PotemkinResponseInterceptorTest show
 * the strict applier WOULD leak — a latent inconsistency, not a live divergence.
 */

import { createGateway } from '../../src/http/gateway.js';
import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import { withPersistentServer } from '../../src/../tests/_support/persistentAgent.js';
import { registerFileTeardown } from '../_support/testTeardown.js';
import type { PersistentAgent } from '../_support/persistentAgent.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'mask-fields');

let agent: PersistentAgent;
let sys: BootedSystem;

beforeAll(async () => {
  const openapi = await loadOpenApi(path.join(FIXTURE, 'openapi', 'mask-fields-demo.yaml'));
  const read = (p: string) => fs.readFileSync(path.join(FIXTURE, p), 'utf8');
  const compiledDsl = await compileDsl([
    { name: 'report', yaml: read('dsl/report.yaml') },
    { name: 'reportById', yaml: read('dsl/report-by-id.yaml') },
  ]);
  sys = await bootSystem({ openapi, compiledDsl });
  const app = createGateway(sys);
  const { agent: a, close } = await withPersistentServer(app);
  agent = a;
  registerFileTeardown(close);

  // ATTACK SETUP: add a third mask field that the stored entity will NOT have.
  // (Operators legitimately do this when a field is sometimes-present.)
  const reportBoundary = sys.dsl.byContractPath['/reports'];
  const reportByIdBoundary = sys.dsl.byContractPath['/reports/{id}'];
  for (const b of [reportBoundary, reportByIdBoundary]) {
    if (b) (b as { mask?: string[] }).mask = ['internalNotes', 'authorEmail', 'sometimesMissing'];
  }
});

const CREATE = {
  title: 'Quarterly',
  summary: 'All good',
  internalNotes: 'SECRET internal notes',
  authorEmail: 'analyst@corp.internal',
  // NOTE: `sometimesMissing` is intentionally omitted -> absent on stored entity.
};

async function createReport(): Promise<string> {
  const res = await agent.post('/reports').send(CREATE).expect(201);
  return res.body.id as string;
}

describe('PARITY: static mask with an absent masked field', () => {
  it('GATEWAY strips the present sensitive fields (autoVivify no-op on the absent one)', async () => {
    const id = await createReport();
    const res = await agent.get(`/reports/${id}`).expect(200);
    // Gateway masks internalNotes + authorEmail; absent field is a no-op.
    expect(res.body.internalNotes).toBeUndefined();
    expect(res.body.authorEmail).toBeUndefined();
    expect(res.body.title).toBe('Quarterly');
  });

  it('FORWARD envelope ships BASE body (UNMASKED) + _patches incl. no-op remove of the absent field', async () => {
    const id = await createReport();
    const res = await agent
      .post('/_engine/forward')
      .send({ method: 'GET', path: `/reports/${id}`, headers: {}, query: {}, body: null })
      .expect(200);

    const env = res.body as {
      status: number;
      body: Record<string, unknown>;
      _patches?: { op: string; path: string }[];
    };

    // eslint-disable-next-line no-console
    console.log('[FORWARD ENVELOPE]', JSON.stringify(env, null, 2));

    expect(env.status).toBe(200);
    // The forward `body` is the BASE — still carries the sensitive fields; the
    // plugin is expected to apply _patches to strip them.
    expect(env.body.internalNotes).toBe('SECRET internal notes');
    expect(env.body.authorEmail).toBe('analyst@corp.internal');

    // The mask journal MUST include a remove for the absent field, which is what
    // the strict Kotlin applier rejects.
    const patches = env._patches ?? [];
    const paths = patches.filter((p) => p.op === 'remove').map((p) => p.path);
    // eslint-disable-next-line no-console
    console.log('[REMOVE PATCHES]', paths);
    expect(paths).toContain('/internalNotes');
    expect(paths).toContain('/authorEmail');
    expect(paths).toContain('/sometimesMissing');

    // The FIRST remove in the journal targeting the absent field will throw in
    // the plugin's strict applier (autoVivify=false), aborting the whole batch
    // and preserving env.body UNMASKED -> internalNotes + authorEmail LEAK.
  });
});
