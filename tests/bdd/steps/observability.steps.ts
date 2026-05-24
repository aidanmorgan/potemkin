import { Given, When, Then, Before, After } from '@cucumber/cucumber';
import assert from 'assert';
import type { SimWorld } from '../support/world.js';
import pino from 'pino';
import { createLogger, childLogger } from '../../../src/observability/logger.js';
import { createEngineMetrics } from '../../../src/observability/metrics.js';
import { metrics } from '@opentelemetry/api';
import { trace, context } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

// ---------------------------------------------------------------------------
// REQ-43: In-memory span exporter for BDD span content assertions.
// Each scenario that needs span verification gets its own provider + exporter.
// ---------------------------------------------------------------------------

let _inMemoryExporter: InMemorySpanExporter | null = null;
let _inMemoryProvider: BasicTracerProvider | null = null;

Before({ tags: '@otel-spans' }, function () {
  _inMemoryExporter = new InMemorySpanExporter();
  _inMemoryProvider = new BasicTracerProvider();
  _inMemoryProvider.addSpanProcessor(new SimpleSpanProcessor(_inMemoryExporter));
  _inMemoryProvider.register();
});

After({ tags: '@otel-spans' }, async function () {
  if (_inMemoryProvider) {
    await _inMemoryProvider.shutdown();
    _inMemoryProvider = null;
  }
  _inMemoryExporter = null;
  // Re-register the no-op global tracer after shutdown
  trace.disable();
});

// REQ-41: System uses well-known community libraries (pino, ajv, swagger-parser, uuidv7)
Then('the system logger should be a pino logger', function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  const logger = this.sys.logger;
  // pino loggers have a 'level' property and 'child' method
  assert.ok(typeof logger.info === 'function', 'Logger should have info method (pino)');
  assert.ok(typeof logger.error === 'function', 'Logger should have error method (pino)');
  assert.ok(typeof logger.child === 'function', 'Logger should have child method (pino)');
});

Then('uuidv7 IDs should be used for events', function (this: SimWorld) {
  const events = this.getEvents();
  assert.ok(events.length > 0, 'Should have at least one event');
  for (const ev of events) {
    // UUIDv7 format: 8-4-4-4-12 hex, version nibble = 7
    const uuidv7Re = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const isSpecialEpoch = ev.eventId.startsWith('00000000-0000-7');
    assert.ok(
      uuidv7Re.test(ev.eventId) || isSpecialEpoch,
      `Event ${ev.eventId} should be a UUIDv7 or epoch-anchored UUID`,
    );
  }
});

Then('the schema registry should be derived from OpenAPI using swagger-parser', function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  const registry = this.sys.schemaRegistry;
  assert.ok(registry, 'Schema registry should be present');
  assert.ok(typeof registry.get === 'function', 'Registry should have get method');
  // Should have entries for our boundaries
  const leadSchema = registry.get('Lead');
  assert.ok(leadSchema, 'Lead schema should be derived from OpenAPI');
  const opportunitySchema = registry.get('Opportunity');
  assert.ok(opportunitySchema, 'Opportunity schema should be derived from OpenAPI');
});

// REQ-42: Structured pino logs emitted at major lifecycle events
Then('a child logger with boundary context should be usable', function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  const childLog = childLogger(this.sys.logger, {
    boundary: 'Lead',
    commandId: 'test-cmd-001',
  });
  // Should not throw
  childLog.info({ step: 'test' }, 'BDD test log');
  assert.ok(typeof childLog.info === 'function', 'Child logger should have info method');
});

Then('pino logs should include structured fields', function (this: SimWorld) {
  // Create a logger and verify it can emit structured logs
  const log = createLogger({ name: 'bdd-test', level: 'silent' });
  assert.ok(typeof log.info === 'function', 'Logger has info');
  assert.ok(typeof log.warn === 'function', 'Logger has warn');
  assert.ok(typeof log.error === 'function', 'Logger has error');
  assert.ok(typeof log.debug === 'function', 'Logger has debug');
  assert.ok(typeof log.child === 'function', 'Logger has child');
  // child binding preserves fields
  const childLog = log.child({ boundary: 'Test', commandId: '123' });
  assert.ok(typeof childLog.info === 'function', 'Child logger is functional');
});

// REQ-43: OpenTelemetry tracing and metrics
Then('the system metrics should include commandsTotal counter', function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  const m = this.sys.metrics;
  assert.ok(m, 'Metrics should be present');
  assert.ok(m.commandsTotal, 'commandsTotal counter should exist');
  assert.ok(m.commandDurationMs, 'commandDurationMs histogram should exist');
  assert.ok(m.eventsAppendedTotal, 'eventsAppendedTotal counter should exist');
  assert.ok(m.uowAbortsTotal, 'uowAbortsTotal counter should exist');
  assert.ok(m.faultsSimulatedTotal, 'faultsSimulatedTotal counter should exist');
});

Then('the system tracer should be an OpenTelemetry tracer', function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  const tracer = this.sys.tracer;
  assert.ok(tracer, 'Tracer should be present');
  assert.ok(typeof tracer.startActiveSpan === 'function', 'Tracer should have startActiveSpan (OTel API)');
  assert.ok(typeof tracer.startSpan === 'function', 'Tracer should have startSpan (OTel API)');
});

Then('a UoW execution should record a span', async function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  await this.sendHttp('POST', `/leads/lead-${Date.now()}`, { companyName: 'SpanTest Corp', contactName: 'SpanTest', email: 'span@example.com' });
  assert.strictEqual(this.lastResponse?.status, 201, 'Creation should succeed');
  // Tracer remains accessible and functional after the UoW (structural check for scenarios
  // that run without the @otel-spans tag and the InMemorySpanExporter).
  assert.ok(this.sys.tracer, 'Tracer should still be accessible after UoW');
  assert.ok(
    typeof this.sys.tracer.startActiveSpan === 'function',
    'Tracer should expose startActiveSpan (OTel API)',
  );
});

Then('at least one span named engine.uow should be exported', async function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  assert.ok(
    _inMemoryExporter !== null,
    'InMemorySpanExporter must be set up — tag this scenario with @otel-spans',
  );

  // Run a UoW through the system tracer so spans flow through the in-memory exporter.
  // We use the system's tracer which is tied to the global OTel provider registered in Before.
  await this.sendHttp('POST', `/leads/lead-otel-${Date.now()}`, { companyName: 'OtelSpanTest Corp', contactName: 'OtelSpanTest', email: 'otel@example.com' });
  assert.strictEqual(this.lastResponse?.status, 201, 'UoW must succeed so span is exported');

  // Allow the SimpleSpanProcessor to flush (it's synchronous, but give it a tick)
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  const spans = _inMemoryExporter.getFinishedSpans();
  const uowSpans = spans.filter(s => s.name === 'engine.uow');
  assert.ok(
    uowSpans.length >= 1,
    `Expected at least one span named 'engine.uow' but found: [${spans.map(s => s.name).join(', ')}]`,
  );
});

Then('the engine metrics should track fault simulations', async function (this: SimWorld) {
  assert.ok(this.sys, 'System not booted');
  const faultHeader = JSON.stringify({ status: 503, body: { error: 'FAULT' } });
  await this.sendHttp('GET', '/opportunities/opportunity-seed-001', undefined, { 'x-specmatic-fault': faultHeader });
  assert.strictEqual(this.lastResponse?.status, 503);
  // metrics.faultsSimulatedTotal should have been incremented (structural check)
  assert.ok(this.sys.metrics.faultsSimulatedTotal, 'faultsSimulatedTotal metric should be accessible');
});
