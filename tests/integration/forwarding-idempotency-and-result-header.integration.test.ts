/**
 * Verifies forwarding idempotency replay stays masked and X-Specmatic-Result parity:
 *   - forwarding idempotency REPLAY re-emits _patches so masked fields stay masked
 *     (parity with the gateway, which records the masked body).
 *   - X-Specmatic-Result is set uniformly — gateway request-validation 400 sets
 *     `failure`, matching the forwarding path.
 */

import { createGateway } from '../../src/http/gateway.js';
import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { loadOpenApi } from '../../src/contract/loader.js';
import { compileDsl } from '../../src/dsl/parser.js';
import { withPersistentServer } from '../_support/persistentAgent.js';
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
  (sys.dsl as { idempotency?: unknown }).idempotency = {
    enabled: true,
    hashIncludesBody: true,
    ttlSeconds: 86400,
  };
  const app = createGateway(sys);
  const { agent: a, close } = await withPersistentServer(app);
  agent = a;
  registerFileTeardown(close);
});

const CREATE = {
  title: 'Quarterly',
  summary: 'All good',
  internalNotes: 'SECRET',
  authorEmail: 'analyst@corp.internal',
};

describe('forwarding idempotency replay stays masked', () => {
  it('forward REPLAY re-emits _patches so masked fields are not leaked', async () => {
    const key = 'idem-fwd-' + Date.now();
    const reqEnvelope = {
      method: 'POST',
      path: '/reports',
      headers: { 'idempotency-key': key },
      query: {},
      body: CREATE,
    };

    const first = await agent.post('/_engine/forward').send(reqEnvelope).expect(200);
    const firstEnv = first.body as { _patches?: { op: string; path: string }[] };

    const replay = await agent.post('/_engine/forward').send(reqEnvelope).expect(200);
    const replayEnv = replay.body as {
      headers?: Record<string, string>;
      _patches?: { op: string; path: string }[];
    };

    // The replay actually happened.
    expect(replayEnv.headers?.['x-idempotency-replay']).toBe('true');

    // ORIGINAL carried the mask removes.
    const origRemoves = (firstEnv._patches ?? []).filter((p) => p.op === 'remove').map((p) => p.path);
    expect(origRemoves).toContain('/internalNotes');
    expect(origRemoves).toContain('/authorEmail');

    // FIXED: replay re-emits the same mask patches so the plugin re-masks.
    const replayRemoves = (replayEnv._patches ?? []).filter((p) => p.op === 'remove').map((p) => p.path);
    expect(replayRemoves).toContain('/internalNotes');
    expect(replayRemoves).toContain('/authorEmail');
  });

  it('gateway replay stays masked (parity reference)', async () => {
    const key = 'idem-gw-' + Date.now();
    const first = await agent.post('/reports').set('Idempotency-Key', key).send(CREATE).expect(201);
    expect(first.body.internalNotes).toBeUndefined();

    const replay = await agent.post('/reports').set('Idempotency-Key', key).send(CREATE).expect(201);
    expect(replay.headers['x-idempotency-replay']).toBe('true');
    expect(replay.body.internalNotes).toBeUndefined();
    expect(replay.body.authorEmail).toBeUndefined();
  });
});

describe('X-Specmatic-Result parity on request contract violation', () => {
  // Body missing required summary/internalNotes/authorEmail → contract violation.
  const BAD_BODY = { title: 'only a title' };

  it('gateway 400 and forward 400 both set x-specmatic-result=failure', async () => {
    const gw = await agent.post('/reports').send(BAD_BODY).expect(400);
    expect(gw.headers['x-specmatic-result']).toBe('failure');

    const fwd = await agent
      .post('/_engine/forward')
      .send({ method: 'POST', path: '/reports', headers: {}, query: {}, body: BAD_BODY })
      .expect(200);
    const env = fwd.body as { status: number; headers?: Record<string, string> };
    expect(env.status).toBe(400);
    expect(env.headers?.['x-specmatic-result']).toBe('failure');
  });
});
