/**
 * administrative fault lifecycle through the real Specmatic path.
 *
 * Admin operations are deliberately sent to Potemkin's control URL. Every
 * business request that proves the resulting behavior is sent to Specmatic,
 * so the plugin, contract validation, forwarding path, and runtime all take
 * part in the assertion.
 */

import * as path from 'node:path';

import { requestThroughSpecmatic } from './_harness/crm-e2e-helpers';
import { startE2eApp } from './_harness/e2e-test-app';
import { startCliServer } from './_harness/server-driver';
import type { E2eApp } from './_harness/e2e-test-app';
const FIXTURE = path.resolve(process.cwd(), 'tests/fixtures/configured-stack');
const DYNAMIC_FAULT_TTL_MS = 30_000;

const MODES = [
  {
    name: 'YAML',
    config: 'potemkin-yaml.yml',
    path: '/things',
    boundary: 'Thing',
    eventType: 'ThingCreated',
    operationId: 'createThing',
  },
  {
    name: 'TypeScript',
    config: 'potemkin-typescript.yml',
    path: '/widgets',
    boundary: 'Widget',
    eventType: 'WidgetCreated',
    operationId: 'createWidget',
  },
  {
    name: 'TypeScript static factory',
    config: 'potemkin-factory.yml',
    path: '/widgets',
    boundary: 'Widget',
    eventType: 'WidgetCreated',
    operationId: 'createWidget',
  },
  {
    name: 'YAML + TypeScript',
    config: 'potemkin-mixed.yml',
    path: '/things',
    boundary: 'Thing',
    eventType: 'ThingCreated',
    operationId: 'createThing',
  },
] as const;

interface HttpResult {
  readonly status: number;
  readonly body: unknown;
}

async function readResult(response: Response): Promise<HttpResult> {
  const text = await response.text();
  let body: unknown = null;
  if (text !== '') {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}

async function admin(
  app: E2eApp,
  requestPath: string,
  init: RequestInit = {},
): Promise<HttpResult> {
  const response = await fetch(`${app.engineUrl}${requestPath}`, init);
  return readResult(response);
}

async function adminAt(
  baseUrl: string,
  requestPath: string,
  init: RequestInit = {},
): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${requestPath}`, init);
  return readResult(response);
}

async function reset(app: E2eApp): Promise<void> {
  const result = await admin(app, '/_admin/reset', { method: 'POST' });
  expect(result.status).toBe(204);
}

async function postFault(
  app: E2eApp,
  mode: (typeof MODES)[number],
  ttlMs = DYNAMIC_FAULT_TTL_MS,
): Promise<string> {
  const result = await admin(app, '/_admin/faults', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `${mode.name.toLowerCase().replaceAll(' ', '-')}-temporary`,
      match: { operationId: mode.operationId },
      response: {
        status: 503,
        body: { code: 'CONFIGURED_DYNAMIC_FAULT' },
        headers: { 'x-potemkin-dynamic-fault': 'true' },
      },
      ttlMs,
    }),
  });
  expect(result.status).toBe(201);
  const body = result.body as { id?: unknown };
  expect(typeof body.id).toBe('string');
  return body.id as string;
}

describe.each(MODES)('$name admin fault lifecycle', (mode) => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp({
      potemkinConfigPath: path.join(FIXTURE, mode.config),
      warmupPath: `${mode.path}/not-created`,
      warmupExpectedStatus: 404,
    });
    expect(app.stubForwardingHealthy).toBe(true);
  }, 180_000);

  afterAll(async () => {
    await app?.shutdown();
  }, 30_000);

  it('registers, forwards, expires, and removes a dynamic fault without committing state', async () => {
    await reset(app);
    const faultId = await postFault(app, mode);

    const blocked = await requestThroughSpecmatic(app.stubUrl, 'POST', mode.path, {
      name: `${mode.name}-blocked`,
    });
    expect(blocked.status).toBe(503);
    expect(blocked.body).toEqual(expect.objectContaining({ code: 'CONFIGURED_DYNAMIC_FAULT' }));
    expect(blocked.headers['x-potemkin-dynamic-fault']).toBe('true');

    const blockedEvents = await admin(app, '/_admin/events?count=true');
    expect(blockedEvents).toEqual({ status: 200, body: { count: 0 } });

    const listed = await admin(app, '/_admin/faults');
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: faultId,
          rule: expect.objectContaining({ name: expect.stringContaining('temporary') }),
        }),
      ]),
    );

    const advanced = await admin(app, '/_admin/clock/advance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ms: DYNAMIC_FAULT_TTL_MS + 1 }),
    });
    expect(advanced).toEqual({
      status: 200,
      body: { offsetMs: DYNAMIC_FAULT_TTL_MS + 1 },
    });

    const recovered = await requestThroughSpecmatic(app.stubUrl, 'POST', mode.path, {
      name: `${mode.name}-recovered`,
    });
    expect(recovered.status).toBe(201);
    expect(recovered.body).toEqual(
      expect.objectContaining({
        name: `${mode.name}-recovered`,
        source: mode.name === 'YAML' || mode.name === 'YAML + TypeScript' ? 'yaml' : 'typescript',
      }),
    );

    const expired = await admin(app, '/_admin/faults');
    expect(expired.status).toBe(200);
    expect(expired.body).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: faultId })]),
    );
  }, 60_000);

  it('keeps a named dynamic fault ahead of every transport control', async () => {
    await reset(app);
    const faultName = `${mode.name.toLowerCase().replaceAll(' ', '-')}-precedence`;
    const registration = await admin(app, '/_admin/faults', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: faultName,
        match: { operationId: mode.operationId },
        response: {
          status: 503,
          body: { code: 'DYNAMIC_PRECEDENCE', message: 'dynamic fault wins' },
          headers: { 'x-potemkin-dynamic-fault': 'true' },
        },
        ttlMs: DYNAMIC_FAULT_TTL_MS,
      }),
    });
    expect(registration.status).toBe(201);
    const faultId = (registration.body as { id: string }).id;

    const blocked = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      mode.path,
      { name: `${mode.name}-dynamic-precedence` },
      {
        'x-potemkin-use-fault': faultName,
        'x-potemkin-force-status': '418',
        'x-potemkin-error-class': 'throttle',
        'x-potemkin-retry-after': '7',
        'x-potemkin-rate-limit': 'true',
        'x-potemkin-success-rate': '0',
        'x-potemkin-response-format': 'jsonapi',
        'x-potemkin-mask': 'name',
        'x-potemkin-body-truncate': '1000',
        'x-potemkin-force-latency': '1',
        'x-potemkin-slow-response': '1',
        'x-potemkin-jitter': '0:0',
        'x-potemkin-drop-connection': '0',
      },
    );
    expect(blocked.status).toBe(503);
    expect(blocked.headers['x-potemkin-dynamic-fault']).toBe('true');
    expect(blocked.headers['x-potemkin-response-format']).toBeUndefined();
    expect(blocked.body).toEqual({
      code: 'DYNAMIC_PRECEDENCE',
      message: 'dynamic fault wins',
    });
    expect(await admin(app, '/_admin/events?count=true')).toEqual({
      status: 200,
      body: { count: 0 },
    });

    const removed = await admin(app, `/_admin/faults/${encodeURIComponent(faultId)}`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(204);

    const recovered = await requestThroughSpecmatic(app.stubUrl, 'POST', mode.path, {
      name: `${mode.name}-dynamic-recovered`,
    });
    expect(recovered.status).toBe(201);
    expect(recovered.body).toEqual(
      expect.objectContaining({
        name: `${mode.name}-dynamic-recovered`,
        source: mode.name === 'YAML' || mode.name === 'YAML + TypeScript' ? 'yaml' : 'typescript',
      }),
    );
  }, 60_000);

  it('isolates concurrent request-local dynamic-fault TTL decisions', async () => {
    await reset(app);
    await postFault(app, mode, DYNAMIC_FAULT_TTL_MS);

    const [future, historical] = await Promise.all([
      requestThroughSpecmatic(
        app.stubUrl,
        'POST',
        mode.path,
        { name: `${mode.name}-future-expired` },
        { 'x-potemkin-clock-offset': String(DYNAMIC_FAULT_TTL_MS + 1) },
      ),
      requestThroughSpecmatic(
        app.stubUrl,
        'POST',
        mode.path,
        { name: `${mode.name}-historical-blocked` },
        { 'x-potemkin-clock-offset': String(-(DYNAMIC_FAULT_TTL_MS + 1)) },
      ),
    ]);

    expect(future.status).toBe(201);
    expect(historical.status).toBe(503);

    const normal = await requestThroughSpecmatic(app.stubUrl, 'POST', mode.path, {
      name: `${mode.name}-normal-blocked`,
    });
    expect(normal.status).toBe(503);

    const events = await admin(app, '/_admin/events?count=true');
    expect(events.status).toBe(200);
    expect(events.body).toEqual(expect.objectContaining({ count: expect.any(Number) }));
    expect((events.body as { count: number }).count).toBeGreaterThan(0);
  }, 60_000);

  it('rejects invalid wire rules before they enter the runtime fault store', async () => {
    await reset(app);
    const invalidStatus = await admin(app, '/_admin/faults', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'invalid-status',
        match: { operationId: mode.operationId },
        response: { status: 99 },
      }),
    });
    expect(invalidStatus.status).toBe(400);
    expect(invalidStatus.body).toEqual(expect.objectContaining({ code: 'INVALID_FAULT_RULE' }));

    const invalidTtl = await admin(app, '/_admin/faults', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'invalid-ttl',
        match: { operationId: mode.operationId },
        response: { status: 503 },
        ttlMs: -1,
      }),
    });
    expect(invalidTtl.status).toBe(400);
    expect(invalidTtl.body).toEqual(expect.objectContaining({ code: 'INVALID_FAULT_RULE' }));

    const invalidExpiry = await admin(app, '/_admin/faults', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'invalid-expiry',
        match: { operationId: mode.operationId },
        response: { status: 503 },
        expiresAt: 0,
      }),
    });
    expect(invalidExpiry.status).toBe(400);
    expect(invalidExpiry.body).toEqual(expect.objectContaining({ code: 'INVALID_FAULT_RULE' }));

    const faults = await admin(app, '/_admin/faults');
    expect(faults).toEqual({ status: 200, body: [] });
  }, 60_000);

  it('reset clears a registered fault, its clock, and the event/state graph', async () => {
    await reset(app);
    await postFault(app, mode, 60_000);
    const blocked = await requestThroughSpecmatic(app.stubUrl, 'POST', mode.path, {
      name: `${mode.name}-reset-blocked`,
    });
    expect(blocked.status).toBe(503);

    const advanced = await admin(app, '/_admin/clock/advance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ms: 2_000 }),
    });
    expect(advanced.status).toBe(200);
    const resetResult = await admin(app, '/_admin/reset', { method: 'POST' });
    expect(resetResult.status).toBe(204);

    const health = await admin(app, '/_admin/health');
    expect(health.body).toEqual(expect.objectContaining({ entityCount: 0, eventCount: 0 }));
    const faults = await admin(app, '/_admin/faults');
    expect(faults).toEqual({ status: 200, body: [] });
    const clock = await admin(app, '/_admin/clock/advance', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ms: 0 }),
    });
    expect(clock).toEqual({ status: 200, body: { offsetMs: 0 } });

    const recovered = await requestThroughSpecmatic(app.stubUrl, 'POST', mode.path, {
      name: `${mode.name}-reset-recovered`,
    });
    expect(recovered.status).toBe(201);
  }, 60_000);

  it('enforces the admin bearer token without changing the Specmatic business path', async () => {
    await reset(app);
    const failOpenServer = await startCliServer({
      configPath: path.join(FIXTURE, mode.config),
    });
    try {
      const failOpen = await adminAt(failOpenServer.url, '/_admin/health');
      expect(failOpen.status).toBe(200);
    } finally {
      await failOpenServer.stop();
    }

    const protectedServer = await startCliServer({
      configPath: path.join(FIXTURE, mode.config),
      adminToken: 'configured-admin-token',
    });
    try {
      const missing = await adminAt(protectedServer.url, '/_admin/health');
      expect(missing).toEqual({
        status: 401,
        body: { error: 'UNAUTHORIZED', message: 'Admin token required' },
      });
      const wrong = await adminAt(protectedServer.url, '/_admin/health', {
        headers: { authorization: 'Bearer wrong-token' },
      });
      expect(wrong.status).toBe(401);
      const authorized = await adminAt(protectedServer.url, '/_admin/health', {
        headers: { authorization: 'Bearer configured-admin-token' },
      });
      expect(authorized.status).toBe(200);
      const modelMissing = await adminAt(protectedServer.url, '/_admin/model');
      expect(modelMissing.status).toBe(401);
      const modelAuthorized = await adminAt(protectedServer.url, '/_admin/model', {
        headers: { authorization: 'Bearer configured-admin-token' },
      });
      expect(modelAuthorized.status).toBe(200);
      expect(modelAuthorized.body).toEqual(
        expect.objectContaining({ schemaVersion: 1, machines: expect.any(Array) }),
      );
    } finally {
      await protectedServer.stop();
    }

    const business = await requestThroughSpecmatic(app.stubUrl, 'POST', mode.path, {
      name: `${mode.name}-admin-auth-business-path`,
    });
    expect(business.status).toBe(201);
  }, 60_000);

  it('exposes filtered raw state/events and deterministic pagination', async () => {
    await reset(app);
    const created = await requestThroughSpecmatic(app.stubUrl, 'POST', mode.path, {
      name: `${mode.name}-admin-query`,
    });
    expect(created.status).toBe(201);
    const entity = created.body as { id?: unknown };
    expect(typeof entity.id).toBe('string');

    const state = await admin(app, `/_admin/state?boundary=${mode.boundary}`);
    expect(state.status).toBe(200);
    expect(state.body).toEqual(
      expect.objectContaining({
        entities: expect.objectContaining({ [entity.id as string]: expect.any(Object) }),
      }),
    );

    const unknownBoundary = await admin(app, '/_admin/state?boundary=UnknownBoundary');
    expect(unknownBoundary).toEqual({
      status: 404,
      body: { code: 'BOUNDARY_NOT_FOUND', message: "Unknown boundary 'UnknownBoundary'" },
    });

    const count = await admin(app, '/_admin/events?count=true');
    expect(count).toEqual({
      status: 200,
      body: { count: mode.name === 'YAML + TypeScript' ? 2 : 1 },
    });
    const filtered = await admin(app, `/_admin/events?type=${mode.eventType}&offset=0&limit=1`);
    expect(filtered.status).toBe(200);
    expect(filtered.body).toEqual({
      events: [expect.objectContaining({ type: mode.eventType })],
    });
    const emptyPage = await admin(app, `/_admin/events?type=${mode.eventType}&offset=1&limit=1`);
    expect(emptyPage).toEqual({ status: 200, body: { events: [] } });

    const unknownFault = await admin(app, '/_admin/faults/does-not-exist', { method: 'DELETE' });
    expect(unknownFault).toEqual({
      status: 404,
      body: { error: 'NOT_FOUND', message: 'No fault rule with id "does-not-exist"' },
    });
  }, 60_000);
});
