/**
 * Final transport observations through the real Specmatic -> plugin -> Potemkin
 * path. The business requests never call /_engine/forward directly.
 */

import * as path from 'node:path';

import { requestThroughSpecmatic } from './_harness/crm-e2e-helpers';
import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';
import type {
  OtlpMetricDataPoint,
  OtlpMetricExport,
  OtlpSpan,
  OtlpTraceExport,
} from './_harness/otlp-collector';
import type { RuntimeTransportObservation } from '../../src/contracts/ports';
const FIXTURE = path.resolve(process.cwd(), 'tests/fixtures/configured-stack');
const OBSERVABILITY_FIXTURE = path.resolve(process.cwd(), 'tests/fixtures/observability');

const MODES = [
  {
    name: 'YAML',
    config: 'potemkin-yaml.yml',
    path: '/things',
    source: 'yaml',
    warmupPath: '/things/not-created',
  },
  {
    name: 'TypeScript',
    config: 'potemkin-typescript.yml',
    path: '/widgets',
    source: 'typescript',
    warmupPath: '/widgets/not-created',
  },
  {
    name: 'mixed YAML and TypeScript',
    config: 'potemkin-mixed.yml',
    path: '/things',
    source: 'yaml',
    warmupPath: '/things/not-created',
  },
] as const;

async function waitForObservation(
  observations: readonly RuntimeTransportObservation[],
  matches: (observation: RuntimeTransportObservation) => boolean,
): Promise<RuntimeTransportObservation> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const observation = observations.find(matches);
    if (observation !== undefined) return observation;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Expected a matching transport observation, received ${observations.length}`);
}

function responseEnvelope(observation: RuntimeTransportObservation): Record<string, unknown> {
  const value = observation.response.body.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Specmatic forwarding observation did not contain a response envelope');
  }
  return value as Record<string, unknown>;
}

function exportedSpans(exports: readonly OtlpTraceExport[]): OtlpSpan[] {
  return exports.flatMap((traceExport) =>
    (traceExport.resourceSpans ?? []).flatMap((resourceSpan) =>
      (resourceSpan.scopeSpans ?? []).flatMap((scopeSpan) => [...(scopeSpan.spans ?? [])]),
    ),
  );
}

function spanAttribute(span: OtlpSpan, key: string): string | number | boolean | undefined {
  const attribute = span.attributes?.find((candidate) => candidate.key === key);
  const value = attribute?.value;
  if (value === undefined) return undefined;
  return value.stringValue ?? value.boolValue ?? value.intValue ?? value.doubleValue;
}

function metricDataPoints(
  exports: readonly OtlpMetricExport[],
  name: string,
): OtlpMetricDataPoint[] {
  return exports.flatMap((metricExport) =>
    (metricExport.resourceMetrics ?? []).flatMap((resourceMetric) =>
      (resourceMetric.scopeMetrics ?? []).flatMap((scopeMetric) =>
        (scopeMetric.metrics ?? []).flatMap((metric) => {
          if (metric.name !== name) return [];
          return [...(metric.sum?.dataPoints ?? []), ...(metric.gauge?.dataPoints ?? [])];
        }),
      ),
    ),
  );
}

function metricAttribute(
  dataPoint: OtlpMetricDataPoint,
  key: string,
): string | number | boolean | undefined {
  const value = dataPoint.attributes?.find((candidate) => candidate.key === key)?.value;
  if (value === undefined) return undefined;
  return value.stringValue ?? value.boolValue ?? value.intValue ?? value.doubleValue;
}

async function waitForMetric(
  app: E2eApp,
  name: string,
  matches: (dataPoint: OtlpMetricDataPoint) => boolean,
): Promise<OtlpMetricDataPoint> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const dataPoint = metricDataPoints(app.otelMetricExports, name).find(matches);
    if (dataPoint !== undefined) return dataPoint;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Expected OTLP metric ${name}, received ${metricDataPoints(app.otelMetricExports, name).length} data points`,
  );
}

async function waitForExportedSpan(app: E2eApp, traceId: string): Promise<OtlpSpan> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const span = exportedSpans(app.otelTraceExports).find(
      (candidate) => spanAttribute(candidate, 'potemkin.trace_id') === traceId,
    );
    if (span !== undefined) return span;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Expected OTLP export for trace ${traceId}, received ${exportedSpans(app.otelTraceExports).length} spans`,
  );
}

async function requestEngine(url: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

describe.each(MODES)('final transport observations  $name', (mode) => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp({
      potemkinConfigPath: path.join(FIXTURE, mode.config),
      warmupPath: mode.warmupPath,
      warmupExpectedStatus: 404,
    });
    expect(app.stubForwardingHealthy).toBe(true);
  }, 180_000);

  afterAll(async () => {
    await app?.shutdown();
  }, 30_000);

  it('records one original request and final successful forwarding response', async () => {
    app.transportObservations.length = 0;
    const traceId = `observed-${mode.name}`;
    const result = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      mode.path,
      { name: `${mode.name}-observed` },
      { 'x-potemkin-trace-id': traceId },
    );

    expect(result.status).toBe(201);
    const observation = await waitForObservation(
      app.transportObservations,
      (candidate) => candidate.correlation.traceId === traceId,
    );
    expect(
      app.transportObservations.filter((candidate) => candidate.correlation.traceId === traceId),
    ).toHaveLength(1);
    expect(observation.request).toMatchObject({
      method: 'POST',
      path: mode.path,
      body: {
        captured: true,
        truncated: false,
        value: { name: `${mode.name}-observed` },
      },
    });
    expect(observation.correlation.traceId).toBe(traceId);
    expect(observation.response.status).toBe(200);
    expect(observation.response.body.captured).toBe(true);
    expect(observation.response.body.truncated).toBe(false);
    expect(responseEnvelope(observation)).toMatchObject({
      status: 201,
      body: expect.objectContaining({
        name: `${mode.name}-observed`,
        source: mode.source,
      }),
    });
  }, 60_000);

  it('exports the final Specmatic-forwarded exchange through the production OTLP exporter', async () => {
    const successTraceId = `otlp-success-${mode.name}`;
    const success = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      mode.path,
      { name: `${mode.name}-otlp-success` },
      { 'x-potemkin-trace-id': successTraceId },
    );

    expect(success.status).toBe(201);
    const successSpan = await waitForExportedSpan(app, successTraceId);
    expect(successSpan.name).toBeDefined();
    expect(spanAttribute(successSpan, 'potemkin.request.method')).toBe('POST');
    expect(spanAttribute(successSpan, 'potemkin.request.path')).toBe(mode.path);
    expect(spanAttribute(successSpan, 'potemkin.trace_id')).toBe(successTraceId);
    expect(spanAttribute(successSpan, 'potemkin.response.status')).toBe(200);
    expect(String(spanAttribute(successSpan, 'potemkin.response.body'))).toContain('"status":201');
    expect(String(spanAttribute(successSpan, 'potemkin.response.body'))).toContain(
      `${mode.name}-otlp-success`,
    );

    const reset = await requestEngine(`${app.engineUrl}/_admin/reset`, { method: 'POST' });
    expect(reset.status).toBe(204);
    const registration = await requestEngine(`${app.engineUrl}/_admin/faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `otlp-${mode.name}-fault`,
        match: { operationId: mode.path === '/things' ? 'createThing' : 'createWidget' },
        response: { status: 503, body: { code: 'OTLP_FAULT' } },
        ttlMs: 60_000,
      }),
    });
    expect(registration.status).toBe(201);

    const faultTraceId = `otlp-fault-${mode.name}`;
    const fault = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      mode.path,
      { name: `${mode.name}-otlp-fault` },
      { 'x-potemkin-trace-id': faultTraceId },
    );

    expect(fault.status).toBe(503);
    const faultSpan = await waitForExportedSpan(app, faultTraceId);
    expect(spanAttribute(faultSpan, 'potemkin.trace_id')).toBe(faultTraceId);
    expect(spanAttribute(faultSpan, 'potemkin.response.status')).toBe(200);
    expect(String(spanAttribute(faultSpan, 'potemkin.response.body'))).toContain('"status":503');
    expect(String(spanAttribute(faultSpan, 'potemkin.response.body'))).toContain('OTLP_FAULT');

    const cleanup = await requestEngine(`${app.engineUrl}/_admin/reset`, { method: 'POST' });
    expect(cleanup.status).toBe(204);
  }, 60_000);

  it('propagates all observability controls through Specmatic', async () => {
    app.transportObservations.length = 0;
    app.logObservations.length = 0;
    app.metricObservations.length = 0;
    const traceId = `observability-controls-${mode.name}`;
    const spanName = `span-${mode.name}`;
    const result = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      mode.path,
      { name: `${mode.name}-controls` },
      {
        'x-potemkin-trace-id': traceId,
        'x-potemkin-span-name': spanName,
        'x-potemkin-log-level': 'error',
        'x-potemkin-metric-tag': `tenant=${mode.name}`,
      },
    );

    expect(result.status).toBe(201);
    expect(result.headers).toEqual(
      expect.objectContaining({
        'x-potemkin-trace-id': traceId,
        'x-potemkin-span-name': spanName,
      }),
    );
    expect(app.logObservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'error',
          message: 'Runtime request matched boundary',
        }),
      ]),
    );
    expect(app.metricObservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'runtime.commands.committed',
          fields: expect.objectContaining({ tenant: mode.name }),
        }),
      ]),
    );
  }, 60_000);

  it('exports source-independent successful, read, and faulted outcomes as OTLP metrics', async () => {
    app.otelMetricExports.length = 0;
    const created = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      mode.path,
      { name: `${mode.name}-metrics-success` },
      { 'x-potemkin-trace-id': `metrics-success-${mode.name}` },
    );
    expect(created.status).toBe(201);
    const createdBody = created.body as { id?: unknown };
    const id = String(createdBody.id ?? '');
    expect(id).not.toBe('');

    const resourcePath = mode.path === '/things' ? `/things/${id}` : `/widgets/${id}`;
    const read = await requestThroughSpecmatic(app.stubUrl, 'GET', resourcePath, null, {
      'x-potemkin-trace-id': `metrics-read-${mode.name}`,
    });
    expect(read.status).toBe(200);

    const registration = await requestEngine(`${app.engineUrl}/_admin/faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `metrics-${mode.name}-fault`,
        match: { operationId: mode.path === '/things' ? 'createThing' : 'createWidget' },
        response: { status: 503, body: { code: 'METRICS_FAULT' } },
        ttlMs: 60_000,
      }),
    });
    expect(registration.status).toBe(201);
    const fault = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      mode.path,
      { name: `${mode.name}-metrics-fault` },
      { 'x-potemkin-trace-id': `metrics-fault-${mode.name}` },
    );
    expect(fault.status).toBe(503);

    const operation = mode.path === '/things' ? 'createThing' : 'createWidget';
    const readOperation = mode.path === '/things' ? 'getThing' : 'getWidget';
    const committed = await waitForMetric(
      app,
      'runtime.requests.completed',
      (dataPoint) =>
        metricAttribute(dataPoint, 'operation') === operation &&
        metricAttribute(dataPoint, 'outcome') === 'committed' &&
        metricAttribute(dataPoint, 'status') === '201',
    );
    expect(Number(committed.asInt ?? committed.asDouble ?? committed.value)).toBeGreaterThan(0);
    await waitForMetric(
      app,
      'runtime.requests.completed',
      (dataPoint) =>
        metricAttribute(dataPoint, 'operation') === readOperation &&
        metricAttribute(dataPoint, 'outcome') === 'completed' &&
        metricAttribute(dataPoint, 'status') === '200',
    );
    await waitForMetric(
      app,
      'runtime.requests.failed',
      (dataPoint) =>
        metricAttribute(dataPoint, 'operation') === operation &&
        metricAttribute(dataPoint, 'outcome') === 'faulted' &&
        metricAttribute(dataPoint, 'status') === '503',
    );
    const events = await waitForMetric(
      app,
      'runtime.events.appended',
      (dataPoint) => metricAttribute(dataPoint, 'operation') === operation,
    );
    expect(Number(events.asInt ?? events.asDouble ?? events.value)).toBeGreaterThan(0);
  }, 60_000);

  it('records the final forwarded fault response and no partial domain commit', async () => {
    const reset = await requestEngine(`${app.engineUrl}/_admin/reset`, { method: 'POST' });
    expect(reset.status).toBe(204);
    app.transportObservations.length = 0;

    const registration = await requestEngine(`${app.engineUrl}/_admin/faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `observed-${mode.name}-fault`,
        match: { operationId: mode.path === '/things' ? 'createThing' : 'createWidget' },
        response: {
          status: 503,
          body: { code: 'OBSERVED_FAULT' },
          headers: { 'x-potemkin-observed': 'true' },
        },
        ttlMs: 60_000,
      }),
    });
    expect(registration.status).toBe(201);
    app.transportObservations.length = 0;

    const result = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      mode.path,
      { name: `${mode.name}-faulted` },
      { 'x-potemkin-trace-id': `fault-${mode.name}` },
    );
    expect(result.status).toBe(503);
    expect(result.body).toEqual(expect.objectContaining({ code: 'OBSERVED_FAULT' }));

    const traceId = `fault-${mode.name}`;
    const observation = await waitForObservation(
      app.transportObservations,
      (candidate) => candidate.correlation.traceId === traceId,
    );
    expect(
      app.transportObservations.filter((candidate) => candidate.correlation.traceId === traceId),
    ).toHaveLength(1);
    expect(observation.response.status).toBe(200);
    expect(responseEnvelope(observation)).toMatchObject({
      status: 503,
      body: { code: 'OBSERVED_FAULT' },
    });
    expect(responseEnvelope(observation).headers).toEqual(
      expect.objectContaining({ 'x-potemkin-observed': 'true' }),
    );
    expect(observation.correlation.traceId).toBe(traceId);

    const events = await requestEngine(`${app.engineUrl}/_admin/events?count=true`);
    expect(await events.json()).toEqual({ count: 0 });
  }, 60_000);

  it('records a control-header chaos response after Specmatic forwarding', async () => {
    app.transportObservations.length = 0;
    const traceId = `chaos-${mode.name}`;
    const result = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      mode.path,
      { name: `${mode.name}-chaos` },
      { 'x-potemkin-trace-id': traceId, 'x-potemkin-force-status': '503' },
    );

    expect(result.status).toBe(503);
    const observation = await waitForObservation(
      app.transportObservations,
      (candidate) => candidate.correlation.traceId === traceId,
    );
    expect(
      app.transportObservations.filter((candidate) => candidate.correlation.traceId === traceId),
    ).toHaveLength(1);
    expect(observation.response.status).toBe(200);
    expect(responseEnvelope(observation)).toMatchObject({ status: 503 });
    expect(observation.correlation.traceId).toBe(traceId);
  }, 60_000);

  it('records an administrative response with the caller trace correlation', async () => {
    app.transportObservations.length = 0;
    const traceId = `admin-${mode.name}`;
    const response = await requestEngine(`${app.engineUrl}/_admin/health`, {
      headers: { 'x-potemkin-trace-id': traceId },
    });
    expect(response.status).toBe(200);
    await response.arrayBuffer();

    const observation = await waitForObservation(
      app.transportObservations,
      (candidate) => candidate.correlation.traceId === traceId,
    );
    expect(observation.request.path).toBe('/_admin/health');
    expect(observation.response.status).toBe(200);
    expect(observation.response.body.captured).toBe(true);
    expect(observation.correlation.traceId).toBe(traceId);
  }, 60_000);

  it('records the forwarding-layer closed-connection result and marker', async () => {
    const reset = await requestEngine(`${app.engineUrl}/_admin/reset`, { method: 'POST' });
    expect(reset.status).toBe(204);
    app.transportObservations.length = 0;
    const traceId = `drop-${mode.name}`;
    const result = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      mode.path,
      { name: `${mode.name}-drop` },
      { 'x-potemkin-trace-id': traceId, 'x-potemkin-drop-connection': '25' },
    );

    expect(result.status).toBe(504);
    expect(result.headers['x-potemkin-dropped']).toBe('true');
    const observation = await waitForObservation(
      app.transportObservations,
      (candidate) => candidate.correlation.traceId === traceId,
    );
    expect(observation.response.status).toBe(200);
    expect(responseEnvelope(observation)).toMatchObject({
      status: 504,
      headers: expect.objectContaining({ 'x-potemkin-dropped': 'true' }),
    });
    expect(observation.correlation.traceId).toBe(traceId);
    const events = await requestEngine(`${app.engineUrl}/_admin/events?count=true`);
    expect(await events.json()).toEqual({ count: 0 });
    const health = await requestEngine(`${app.engineUrl}/_admin/health`);
    expect((await health.json()) as { entityCount: number }).toMatchObject({ entityCount: 0 });
  }, 60_000);
});

const BULK_MODES = [
  { name: 'YAML', config: 'potemkin-yaml.yml', source: 'yaml' },
  { name: 'TypeScript', config: 'potemkin-typescript.yml', source: 'typescript' },
  {
    name: 'mixed YAML and TypeScript',
    config: 'potemkin-mixed.yml',
    source: 'typescript',
  },
] as const;

describe.each(BULK_MODES)('transactional bulk observations — $name', (mode) => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp({
      fixtureName: 'observability',
      potemkinConfigPath: path.join(OBSERVABILITY_FIXTURE, mode.config),
      warmupPath: '/records/bulk/not-created',
      warmupExpectedStatus: 404,
    });
    expect(app.stubForwardingHealthy).toBe(true);
  }, 180_000);

  afterAll(async () => {
    await app?.shutdown();
  }, 30_000);

  it('captures a successful transactional bulk response through Specmatic', async () => {
    app.transportObservations.length = 0;
    const traceId = `bulk-success-${mode.name}`;
    const result = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/records/bulk',
      [
        { id: `${mode.name.toLowerCase()}-one`, name: 'one' },
        { id: `${mode.name.toLowerCase()}-two`, name: 'two' },
      ],
      {
        'x-potemkin-trace-id': traceId,
        'x-potemkin-bulk-transactional': 'true',
      },
    );

    expect(result.status).toBe(201);
    expect(result.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: mode.source }),
        expect.objectContaining({ source: mode.source }),
      ]),
    );
    const observation = await waitForObservation(
      app.transportObservations,
      (candidate) => candidate.correlation.traceId === traceId,
    );
    expect(
      app.transportObservations.filter((candidate) => candidate.correlation.traceId === traceId),
    ).toHaveLength(1);
    expect(observation.request.body.value).toEqual([
      { id: `${mode.name.toLowerCase()}-one`, name: 'one' },
      { id: `${mode.name.toLowerCase()}-two`, name: 'two' },
    ]);
    expect(responseEnvelope(observation)).toMatchObject({ status: 201 });
    expect(observation.correlation.traceId).toBe(traceId);
  }, 60_000);

  it('captures transactional bulk rollback without a partial state or event graph', async () => {
    const reset = await requestEngine(`${app.engineUrl}/_admin/reset`, { method: 'POST' });
    expect(reset.status).toBe(204);
    await reset.arrayBuffer();
    app.transportObservations.length = 0;
    const traceId = `bulk-rollback-${mode.name}`;
    const duplicateId = `${mode.name.toLowerCase()}-duplicate`;
    const result = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/records/bulk',
      [
        { id: duplicateId, name: 'first' },
        { id: duplicateId, name: 'duplicate' },
      ],
      {
        'x-potemkin-trace-id': traceId,
        'x-potemkin-bulk-transactional': 'true',
      },
    );

    expect(result.status).toBe(409);
    const observation = await waitForObservation(
      app.transportObservations,
      (candidate) => candidate.correlation.traceId === traceId,
    );
    expect(responseEnvelope(observation)).toMatchObject({ status: 409 });
    expect(observation.correlation.traceId).toBe(traceId);

    const events = await requestEngine(`${app.engineUrl}/_admin/events?count=true`);
    expect(await events.json()).toEqual({ count: 0 });
    const state = await requestThroughSpecmatic(app.stubUrl, 'GET', `/records/bulk/${duplicateId}`);
    expect(state.status).toBe(404);
  }, 60_000);

  it('exports source-independent metrics for committed and rolled-back bulk outcomes', async () => {
    app.otelMetricExports.length = 0;
    const prefix = mode.name.toLowerCase();
    const successful = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/records/bulk',
      [
        { id: `${prefix}-metrics-one`, name: 'one' },
        { id: `${prefix}-metrics-two`, name: 'two' },
      ],
      {
        'x-potemkin-trace-id': `bulk-metrics-success-${mode.name}`,
        'x-potemkin-bulk-transactional': 'true',
      },
    );
    expect(successful.status).toBe(201);

    const committed = await waitForMetric(
      app,
      'runtime.requests.completed',
      (dataPoint) =>
        metricAttribute(dataPoint, 'operation') === 'createRecordBatch' &&
        metricAttribute(dataPoint, 'outcome') === 'committed' &&
        metricAttribute(dataPoint, 'status') === '201',
    );
    expect(Number(committed.asInt ?? committed.asDouble ?? committed.value)).toBeGreaterThan(0);
    const appended = await waitForMetric(
      app,
      'runtime.events.appended',
      (dataPoint) =>
        metricAttribute(dataPoint, 'operation') === 'createRecordBatch' &&
        metricAttribute(dataPoint, 'outcome') === 'committed',
    );
    expect(Number(appended.asInt ?? appended.asDouble ?? appended.value)).toBeGreaterThan(0);

    const reset = await requestEngine(`${app.engineUrl}/_admin/reset`, { method: 'POST' });
    expect(reset.status).toBe(204);
    app.otelMetricExports.length = 0;
    const duplicateId = `${prefix}-metrics-duplicate`;
    const rolledBack = await requestThroughSpecmatic(
      app.stubUrl,
      'POST',
      '/records/bulk',
      [
        { id: duplicateId, name: 'first' },
        { id: duplicateId, name: 'duplicate' },
      ],
      {
        'x-potemkin-trace-id': `bulk-metrics-rollback-${mode.name}`,
        'x-potemkin-bulk-transactional': 'true',
      },
    );
    expect(rolledBack.status).toBe(409);

    await waitForMetric(
      app,
      'runtime.requests.completed',
      (dataPoint) =>
        metricAttribute(dataPoint, 'operation') === 'createRecordBatch' &&
        metricAttribute(dataPoint, 'outcome') === 'error' &&
        metricAttribute(dataPoint, 'status') === '409',
    );
    await waitForMetric(
      app,
      'runtime.requests.failed',
      (dataPoint) =>
        metricAttribute(dataPoint, 'operation') === 'createRecordBatch' &&
        metricAttribute(dataPoint, 'outcome') === 'error' &&
        metricAttribute(dataPoint, 'status') === '409',
    );
  }, 60_000);
});
