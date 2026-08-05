import * as path from 'node:path';

import { requestThroughSpecmatic, getEventCount, getGraphNode } from './_harness/crm-e2e-helpers';
import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
const FIXTURE = path.resolve(process.cwd(), 'tests/fixtures/validation-controls');

const MODES = [
  { name: 'YAML', config: 'potemkin-yaml.yml' },
  { name: 'TypeScript', config: 'potemkin-typescript.yml' },
  { name: 'mixed YAML and TypeScript', config: 'potemkin-mixed.yml' },
] as const;

const profile = (suffix: string) => ({
  id: `validation-${suffix}`,
  displayName: `Validation ${suffix}`,
});

describe.each(MODES)('validation controls through Specmatic — $name', (mode) => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp({
      fixtureName: 'validation-controls',
      potemkinConfigPath: path.join(FIXTURE, mode.config),
      warmupPath: '/profiles/not-created',
      warmupExpectedStatus: 404,
    });
    expect(app.stubForwardingHealthy).toBe(true);
  }, 180_000);

  afterAll(async () => {
    await app?.shutdown();
  }, 30_000);

  beforeEach(async () => {
    const reset = await fetch(`${app.engineUrl}/_admin/reset`, { method: 'POST' });
    expect(reset.status).toBe(204);
  });

  it('keeps strict response validation before commit and gates both bypass controls', async () => {
    const id = `${mode.name.toLowerCase().replaceAll(' ', '-')}-strict`;
    const body = profile(id);

    const invalid = await requestThroughSpecmatic(app.stubUrl, 'POST', '/profiles', body);
    expect(invalid.status).toBe(500);
    expect(invalid.body).toEqual(expect.objectContaining({ code: 'INTERNAL_EXECUTION_ERROR' }));
    expect(await getEventCount(app.engineUrl)).toBe(0);
    expect(await getGraphNode(app.engineUrl, id)).toBeNull();

    const skipped = await requestThroughSpecmatic(app.stubUrl, 'POST', '/profiles', body, {
      authorization: 'Bearer admin:admin',
      'x-potemkin-skip-response-validation': 'true',
    });
    expect(skipped.status).toBe(201);
    expect(skipped.body).toEqual(
      expect.objectContaining({ ...body, unexpected: 'response-transform' }),
    );
    expect(await getEventCount(app.engineUrl)).toBe(1);

    const nextId = `${mode.name.toLowerCase().replaceAll(' ', '-')}-additional`;
    const allowed = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/profiles',
      profile(nextId),
      {
        authorization: 'Bearer admin:admin',
        'x-potemkin-allow-additional-properties': 'true',
      },
    );
    expect(allowed.status).toBe(201);
    expect(allowed.body).toEqual(
      expect.objectContaining({ ...profile(nextId), unexpected: 'response-transform' }),
    );
    expect(await getEventCount(app.engineUrl)).toBe(2);
  });

  it('keeps response-validation controls administrator-only', async () => {
    const body = profile(`${mode.name.toLowerCase().replaceAll(' ', '-')}-auth`);

    const missing = await requestThroughSpecmatic(app.stubUrl, 'POST', '/profiles', body, {
      'x-potemkin-skip-response-validation': 'true',
    });
    expect(missing.status).toBe(401);

    const insufficient = await requestThroughSpecmatic(app.stubUrl, 'POST', '/profiles', body, {
      authorization: 'Bearer user:user',
      'x-potemkin-allow-additional-properties': 'true',
    });
    expect(insufficient.status).toBe(403);

    expect(await getEventCount(app.engineUrl)).toBe(0);
  });

  it('separates request-validation bypass from response-validation bypass', async () => {
    const body = {
      ...profile(`${mode.name.toLowerCase().replaceAll(' ', '-')}-request`),
      unexpectedRequest: "accepted only by Specmatic's relaxed contract",
    };

    const rejected = await requestThroughSpecmatic(app.stubUrl, 'POST', '/profiles', body);
    expect(rejected.status).toBe(400);
    expect(rejected.body).toEqual(expect.objectContaining({ code: 'CONTRACT_VIOLATION' }));
    expect(await getEventCount(app.engineUrl)).toBe(0);

    const bypassed = await requestThroughSpecmatic(app.stubUrl, 'POST', '/profiles', body, {
      authorization: 'Bearer admin:admin',
      'x-potemkin-skip-request-validation': 'true',
      'x-potemkin-skip-response-validation': 'true',
    });
    expect(bypassed.status).toBe(201);
    expect(bypassed.body).toEqual(
      expect.objectContaining({
        id: body.id,
        displayName: body.displayName,
        unexpected: 'response-transform',
      }),
    );
    expect(await getEventCount(app.engineUrl)).toBe(1);
  });

  it('validates the response before a request mask can hide an invalid field', async () => {
    const body = profile(`${mode.name.toLowerCase().replaceAll(' ', '-')}-mask-order`);
    const maskedInvalidResponse = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/profiles',
      body,
      { 'x-potemkin-mask': 'unexpected' },
    );

    expect(maskedInvalidResponse.status).toBe(500);
    expect(maskedInvalidResponse.body).toEqual(
      expect.objectContaining({ code: 'INTERNAL_EXECUTION_ERROR' }),
    );
    expect(await getEventCount(app.engineUrl)).toBe(0);
    expect(await getGraphNode(app.engineUrl, body.id)).toBeNull();
  });
});
