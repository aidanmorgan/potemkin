/**
 * Transactional bulk and side-effect-control combinations through
 * Specmatic -> the Potemkin plugin -> the new runtime.
 */

import * as http from 'node:http';
import * as path from 'node:path';

import { requestThroughSpecmatic } from './_harness/crm-e2e-helpers';
import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
const FIXTURE = path.resolve(process.cwd(), 'tests/fixtures/observability');
const WEBHOOK_PORT = 19879;

const MODES = [
  { name: 'YAML', config: 'potemkin-yaml.yml', source: 'yaml' },
  { name: 'TypeScript', config: 'potemkin-typescript.yml', source: 'typescript' },
  { name: 'mixed YAML and TypeScript', config: 'potemkin-mixed.yml', source: 'typescript' },
] as const;

interface WebhookDelivery {
  readonly body: string;
}

interface EventRecord {
  readonly type: string;
  readonly aggregateId: string;
}

interface StateResponse {
  readonly entities: Record<string, Record<string, unknown>>;
}

async function waitFor<T>(read: () => T | undefined, description: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function jsonAt<T>(app: E2eApp, requestPath: string): Promise<T> {
  const response = await fetch(`${app.engineUrl}${requestPath}`);
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

async function reset(app: E2eApp, deliveries: WebhookDelivery[]): Promise<void> {
  const response = await fetch(`${app.engineUrl}/_admin/reset`, { method: 'POST' });
  expect(response.status).toBe(204);
  deliveries.length = 0;
}

describe.each(MODES)('bulk side-effect parity through Specmatic — $name', (mode) => {
  let app: E2eApp;
  let webhookServer: http.Server;
  let deliveries: WebhookDelivery[];

  beforeAll(async () => {
    deliveries = [];
    webhookServer = http.createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        deliveries.push({ body });
        response.statusCode = 204;
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      webhookServer.listen(WEBHOOK_PORT, '127.0.0.1', () => resolve());
      webhookServer.once('error', reject);
    });
    app = await startE2eApp({
      fixtureName: 'observability',
      potemkinConfigPath: path.join(FIXTURE, mode.config),
      warmupPath: '/records/bulk/not-created',
      warmupExpectedStatus: 404,
    });
    expect(app.stubForwardingHealthy).toBe(true);
  }, 180_000);

  afterAll(async () => {
    await app?.shutdown();
    await new Promise<void>((resolve) => webhookServer?.close(() => resolve()));
  }, 30_000);

  beforeEach(async () => {
    await reset(app, deliveries);
  });

  it('commits every primary and secondary effect atomically for a successful bulk', async () => {
    const firstId = `bulk-${mode.name.toLowerCase().replaceAll(' ', '-')}-one`;
    const secondId = `bulk-${mode.name.toLowerCase().replaceAll(' ', '-')}-two`;
    const result = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/records/bulk',
      [
        { id: firstId, name: 'first' },
        { id: secondId, name: 'second' },
      ],
      { 'x-potemkin-bulk-transactional': 'true' },
    );

    expect(result.status).toBe(201);
    expect(result.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: firstId, name: 'first', source: mode.source }),
        expect.objectContaining({ id: secondId, name: 'second', source: mode.source }),
      ]),
    );

    const events = await jsonAt<{ events: readonly EventRecord[] }>(app, '/_admin/events');
    expect(events.events).toHaveLength(14);
    expect(events.events.filter((event) => event.type === 'RecordCreated')).toHaveLength(2);
    expect(events.events.filter((event) => event.type === 'BulkReceiptCreated')).toHaveLength(4);
    expect(events.events.filter((event) => event.type === 'BulkAuditRecorded')).toHaveLength(2);
    expect(events.events.filter((event) => event.type === 'SagaStarted')).toHaveLength(2);
    expect(events.events.filter((event) => event.type === 'SagaStepCompleted')).toHaveLength(2);
    expect(events.events.filter((event) => event.type === 'SagaCompleted')).toHaveLength(2);

    const state = await jsonAt<StateResponse>(app, '/_admin/state');
    expect(Object.keys(state.entities)).toHaveLength(8);
    expect(state.entities[firstId]).toEqual(
      expect.objectContaining({ id: firstId, name: 'first' }),
    );
    expect(state.entities[`${firstId}-receipt`]).toEqual(
      expect.objectContaining({ recordId: firstId, kind: 'dispatch' }),
    );
    expect(state.entities[`${firstId}-saga-receipt`]).toEqual(
      expect.objectContaining({ recordId: firstId, kind: 'saga' }),
    );

    const projection = await jsonAt<Record<string, Record<string, unknown>>>(
      app,
      '/_admin/derived/BulkSummary',
    );
    expect(projection[firstId]).toEqual({ name: 'first', created: true });
    expect(projection[secondId]).toEqual({ name: 'second', created: true });
    await waitFor(() => (deliveries.length === 2 ? deliveries : undefined), 'both bulk webhooks');
    expect(deliveries.map((delivery) => JSON.parse(delivery.body))).toEqual(
      expect.arrayContaining([
        { recordId: firstId, event: 'RecordCreated', name: 'first' },
        { recordId: secondId, event: 'RecordCreated', name: 'second' },
      ]),
    );
  }, 60_000);

  it('suppresses all secondary work while retaining the primary bulk commit', async () => {
    const firstId = `suppressed-${mode.name.toLowerCase().replaceAll(' ', '-')}-one`;
    const secondId = `suppressed-${mode.name.toLowerCase().replaceAll(' ', '-')}-two`;
    const result = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/records/bulk',
      [
        { id: firstId, name: 'first' },
        { id: secondId, name: 'second' },
      ],
      {
        'x-potemkin-bulk-transactional': 'true',
        'x-potemkin-skip-sagas': 'true',
        'x-potemkin-skip-webhooks': 'true',
        'x-potemkin-skip-projections': 'true',
        'x-potemkin-skip-reactions': 'true',
        'x-potemkin-skip-dispatch': 'true',
      },
    );

    expect(result.status).toBe(201);
    const events = await jsonAt<{ events: readonly EventRecord[] }>(app, '/_admin/events');
    expect(events.events).toEqual([
      expect.objectContaining({ type: 'RecordCreated', aggregateId: firstId }),
      expect.objectContaining({ type: 'RecordCreated', aggregateId: secondId }),
    ]);
    const state = await jsonAt<StateResponse>(app, '/_admin/state');
    expect(Object.keys(state.entities)).toEqual(expect.arrayContaining([firstId, secondId]));
    expect(Object.keys(state.entities)).toHaveLength(2);
    expect(await jsonAt<Record<string, unknown>>(app, '/_admin/derived/BulkSummary')).toEqual({});
    expect(deliveries).toHaveLength(0);
  }, 60_000);

  it('keeps selected effects when suppression controls are combined', async () => {
    const firstId = `partial-${mode.name.toLowerCase().replaceAll(' ', '-')}-one`;
    const secondId = `partial-${mode.name.toLowerCase().replaceAll(' ', '-')}-two`;
    const result = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/records/bulk',
      [
        { id: firstId, name: 'first' },
        { id: secondId, name: 'second' },
      ],
      {
        'x-potemkin-bulk-transactional': 'true',
        'x-potemkin-skip-projections': 'true',
        'x-potemkin-skip-webhooks': 'true',
        'x-potemkin-skip-dispatch': 'true',
      },
    );

    expect(result.status).toBe(201);
    const events = await jsonAt<{ events: readonly EventRecord[] }>(app, '/_admin/events');
    expect(events.events).toHaveLength(12);
    expect(events.events.filter((event) => event.type === 'RecordCreated')).toHaveLength(2);
    expect(events.events.filter((event) => event.type === 'BulkAuditRecorded')).toHaveLength(2);
    expect(events.events.filter((event) => event.type === 'SagaStarted')).toHaveLength(2);
    expect(events.events.filter((event) => event.type === 'SagaStepCompleted')).toHaveLength(2);
    expect(events.events.filter((event) => event.type === 'SagaCompleted')).toHaveLength(2);
    expect(
      events.events.some(
        (event) =>
          event.type === 'BulkReceiptCreated' &&
          [firstId, secondId].some((id) => event.aggregateId === `${id}-receipt`),
      ),
    ).toBe(false);
    expect(await jsonAt<Record<string, unknown>>(app, '/_admin/derived/BulkSummary')).toEqual({});
    expect(deliveries).toHaveLength(0);
  }, 60_000);

  it('rolls back every bulk item and all secondary work on a transactional conflict', async () => {
    const duplicateId = `duplicate-${mode.name.toLowerCase().replaceAll(' ', '-')}`;
    const result = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/records/bulk',
      [
        { id: duplicateId, name: 'first' },
        { id: duplicateId, name: 'duplicate' },
      ],
      { 'x-potemkin-bulk-transactional': 'true' },
    );

    expect(result.status).toBe(409);
    expect(await jsonAt<{ events: readonly unknown[] }>(app, '/_admin/events')).toEqual({
      events: [],
    });
    expect(await jsonAt<StateResponse>(app, '/_admin/state')).toEqual({ entities: {} });
    expect(await jsonAt<Record<string, unknown>>(app, '/_admin/derived/BulkSummary')).toEqual({});
    expect(deliveries).toHaveLength(0);
  }, 60_000);

  it('applies alternate response formats to every bulk item', async () => {
    const jsonApiResult = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/records/bulk',
      [
        { id: `format-${mode.name}-one`, name: 'json api one' },
        { id: `format-${mode.name}-two`, name: 'json api two' },
      ],
      { 'x-potemkin-response-format': 'jsonapi' },
    );
    expect(jsonApiResult.status).toBe(201);
    expect(jsonApiResult.headers['x-potemkin-response-format']).toBe('jsonapi');
    expect(jsonApiResult.body).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'RecordBatch',
          id: `format-${mode.name}-one`,
          attributes: expect.objectContaining({ name: 'json api one', source: mode.source }),
        }),
      }),
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'RecordBatch',
          id: `format-${mode.name}-two`,
          attributes: expect.objectContaining({ name: 'json api two', source: mode.source }),
        }),
      }),
    ]);

    await reset(app, deliveries);
    const halResult = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/records/bulk',
      [{ id: `format-${mode.name}-hal`, name: 'hal' }],
      { 'x-potemkin-response-format': 'hal' },
    );
    expect(halResult.status).toBe(201);
    expect(halResult.headers['x-potemkin-response-format']).toBe('hal');
    expect(halResult.body).toEqual([
      expect.objectContaining({
        id: `format-${mode.name}-hal`,
        name: 'hal',
        source: mode.source,
        _links: { self: { href: '/records/bulk' } },
      }),
    ]);
  }, 60_000);

  it('masks every bulk item without masking committed state or secondary work', async () => {
    const firstId = `mask-${mode.name.toLowerCase().replaceAll(' ', '-')}-plain-one`;
    const secondId = `mask-${mode.name.toLowerCase().replaceAll(' ', '-')}-plain-two`;
    const plainResult = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/records/bulk',
      [
        { id: firstId, name: 'plain first' },
        { id: secondId, name: 'plain second' },
      ],
      { 'x-potemkin-mask': 'name' },
    );

    expect(plainResult.status).toBe(201);
    expect(plainResult.body).toEqual([
      expect.objectContaining({ id: firstId, name: '[MASKED]', source: mode.source }),
      expect.objectContaining({ id: secondId, name: '[MASKED]', source: mode.source }),
    ]);

    const plainState = await jsonAt<StateResponse>(app, '/_admin/state');
    expect(plainState.entities[firstId]).toEqual(
      expect.objectContaining({ id: firstId, name: 'plain first' }),
    );
    expect(plainState.entities[secondId]).toEqual(
      expect.objectContaining({ id: secondId, name: 'plain second' }),
    );
    expect(plainState.entities[`${firstId}-receipt`]).toEqual(
      expect.objectContaining({ recordId: firstId }),
    );
    expect(plainState.entities[`${secondId}-receipt`]).toEqual(
      expect.objectContaining({ recordId: secondId }),
    );

    await reset(app, deliveries);
    const jsonApiFirstId = `mask-${mode.name.toLowerCase().replaceAll(' ', '-')}-jsonapi-one`;
    const jsonApiSecondId = `mask-${mode.name.toLowerCase().replaceAll(' ', '-')}-jsonapi-two`;
    const jsonApiResult = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/records/bulk',
      [
        { id: jsonApiFirstId, name: 'json api first' },
        { id: jsonApiSecondId, name: 'json api second' },
      ],
      {
        'x-potemkin-response-format': 'jsonapi',
        'x-potemkin-mask': 'name',
      },
    );

    expect(jsonApiResult.status).toBe(201);
    expect(jsonApiResult.body).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          id: jsonApiFirstId,
          attributes: expect.objectContaining({ name: '[MASKED]', source: mode.source }),
        }),
      }),
      expect.objectContaining({
        data: expect.objectContaining({
          id: jsonApiSecondId,
          attributes: expect.objectContaining({ name: '[MASKED]', source: mode.source }),
        }),
      }),
    ]);

    const jsonApiState = await jsonAt<StateResponse>(app, '/_admin/state');
    expect(jsonApiState.entities[jsonApiFirstId]).toEqual(
      expect.objectContaining({ id: jsonApiFirstId, name: 'json api first' }),
    );
    expect(jsonApiState.entities[jsonApiSecondId]).toEqual(
      expect.objectContaining({ id: jsonApiSecondId, name: 'json api second' }),
    );
  }, 60_000);

  it('forwards the bulk alternate-format mask as a patch journal', async () => {
    app.transportObservations.length = 0;
    const traceId = `bulk-patch-journal-${mode.name}`;
    const firstId = `patch-journal-${mode.name}-one`;
    const secondId = `patch-journal-${mode.name}-two`;
    const result = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/records/bulk',
      [
        { id: firstId, name: 'first patch' },
        { id: secondId, name: 'second patch' },
      ],
      {
        'x-potemkin-bulk-transactional': 'true',
        'x-potemkin-response-format': 'jsonapi',
        'x-potemkin-mask': 'name',
        'x-potemkin-trace-id': traceId,
      },
    );

    expect(result.status).toBe(201);
    expect(result.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            id: firstId,
            attributes: expect.objectContaining({ name: '[MASKED]', source: mode.source }),
          }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            id: secondId,
            attributes: expect.objectContaining({ name: '[MASKED]', source: mode.source }),
          }),
        }),
      ]),
    );
    expect(JSON.stringify(result.body)).not.toContain('_patches');

    const observation = await waitFor(
      () =>
        app.transportObservations.find((candidate) => candidate.correlation.traceId === traceId),
      'the bulk alternate-format patch journal',
    );
    const envelope = observation.response.body.value as Record<string, unknown>;
    expect(envelope.body).toEqual(result.body);
    expect(envelope._patches).toEqual(
      expect.arrayContaining([expect.objectContaining({ op: expect.any(String), source: 'mask' })]),
    );
    expect(
      (envelope._patches as readonly Record<string, unknown>[]).every(
        (patch) => typeof patch.path === 'string' && patch.path.length > 0,
      ),
    ).toBe(true);

    const state = await jsonAt<StateResponse>(app, '/_admin/state');
    expect(state.entities[firstId]).toEqual(expect.objectContaining({ name: 'first patch' }));
    expect(state.entities[secondId]).toEqual(expect.objectContaining({ name: 'second patch' }));
  }, 60_000);
});
