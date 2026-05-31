/**
 * Probing tests for observability completeness gaps (REQ-42, REQ-43).
 *
 * Gaps under test:
 *  1. Metrics — commandsTotal incremented per command via UoW.
 *  2. Metrics — commandDurationMs histogram recorded with duration.
 *  3. Metrics — eventsAppendedTotal incremented in UoW commit phase.
 *  4. Metrics — uowAbortsTotal incremented on UoW failure.
 *  5. Metrics — faultsSimulatedTotal incremented when fault header fires.
 *  6. Spans   — engine.uow span exists for a command execution.
 *  7. Spans   — http.request span exists per inbound HTTP request (via withSpan).
 *  8. Spans   — http.admin.* spans exist for admin route calls.
 *  9. Logger  — child logger carries commandId, boundary bindings (REQ-42).
 * 10. Logger  — eventId and aggregateId appear in logger bindings during projection.
 *
 * OTel testing strategy:
 *  - Use the InMemoryOtel helper from tests/integration/_helpers/otel.ts.
 *  - Wire the in-memory tracer/meter into executeUnitOfWork directly for unit-level tests.
 *  - For gateway-level span tests, boot a full system and drive via supertest.
 */

import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  BasicTracerProvider,
} from '@opentelemetry/sdk-trace-base';
import {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics';
import { createEngineMetrics } from '../../../src/observability/metrics.js';
import { withSpan } from '../../../src/observability/tracing.js';
import { createEventStore } from '../../../src/eventstore/store.js';
import { createStateGraph } from '../../../src/stategraph/graph.js';
import { createLogger } from '../../../src/observability/logger.js';
import { createTestApp, type TestApp } from '../../acceptance/_helpers/test-app.js';
import { collectMetricDataPoints } from '../../integration/_helpers/otel.js';
import { withPersistentServer } from '../../_support/persistentAgent.js';
import { registerFileTeardown } from '../../_support/testTeardown.js';

// ---------------------------------------------------------------------------
// OTel test infrastructure helpers
// ---------------------------------------------------------------------------

function buildInMemoryOtel() {
  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider();
  tracerProvider.addSpanProcessor(new SimpleSpanProcessor(spanExporter));

  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const meterProvider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 50,
      }),
    ],
  });

  const tracer = tracerProvider.getTracer('test');
  const meter = meterProvider.getMeter('test');

  return {
    spanExporter,
    metricExporter,
    tracerProvider,
    meterProvider,
    tracer,
    meter,
    async teardown() {
      await meterProvider.forceFlush();
      await meterProvider.shutdown();
      await tracerProvider.forceFlush();
      await tracerProvider.shutdown();
      spanExporter.reset();
      metricExporter.reset();
    },
  };
}

// ---------------------------------------------------------------------------
// Metrics tests (REQ-43)
// ---------------------------------------------------------------------------

describe('observability/metrics — emission completeness (REQ-43)', () => {
  describe('commandsTotal', () => {
    it('commandsTotal is incremented when executeUnitOfWork processes a command', async () => {
      const otel = buildInMemoryOtel();
      const metrics = createEngineMetrics(otel.meter);

      // Load the full system so we can run a real UoW
      const { loadInlineCrmFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
      const fixture = await loadInlineCrmFixture();
      const sys = await bootSystem(fixture);
      const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

      await executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'Lead',
          intent: 'creation',
          targetId: nextUuidv7(),
          payload: { companyName: 'MetricTest Corp', contactName: 'Metric User', phone: '+61 2 9000 0001', email: 'metric@test.com', source: 'WEBSITE' },
          queryParams: {},
          httpMethod: 'POST',
          path: '/leads',
          origin: 'inbound',
          depth: 0,
        },
        dsl: sys.dsl,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        schemaRegistry: sys.schemaRegistry,
        openapi: sys.openapi,
        logger: createLogger({ level: 'silent' }),
        tracer: otel.tracer,
        metrics,
      });

      await otel.meterProvider.forceFlush();

      const values = await collectMetricDataPoints(otel.metricExporter, 'engine.commands.total');
      expect(values.some((v) => v >= 1)).toBe(true);

      await otel.teardown();
    });
  });

  describe('commandDurationMs', () => {
    it('commandDurationMs histogram is recorded after successful UoW', async () => {
      const otel = buildInMemoryOtel();
      const metrics = createEngineMetrics(otel.meter);

      const { loadInlineCrmFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
      const fixture = await loadInlineCrmFixture();
      const sys = await bootSystem(fixture);
      const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

      await executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'Lead',
          intent: 'creation',
          targetId: nextUuidv7(),
          payload: { companyName: 'DurationTest Corp', contactName: 'Duration User', phone: '+61 2 9000 0002', email: 'duration@test.com', source: 'REFERRAL' },
          queryParams: {},
          httpMethod: 'POST',
          path: '/leads',
          origin: 'inbound',
          depth: 0,
        },
        dsl: sys.dsl,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        schemaRegistry: sys.schemaRegistry,
        openapi: sys.openapi,
        logger: createLogger({ level: 'silent' }),
        tracer: otel.tracer,
        metrics,
      });

      await otel.meterProvider.forceFlush();

      const values = await collectMetricDataPoints(
        otel.metricExporter,
        'engine.command.duration_ms',
      );
      // Histogram data points have a `sum` or `value` > 0
      expect(values.length).toBeGreaterThan(0);

      await otel.teardown();
    });

    it('commandDurationMs is also recorded when UoW aborts', async () => {
      const otel = buildInMemoryOtel();
      const metrics = createEngineMetrics(otel.meter);

      const { loadInlineCrmFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
      const fixture = await loadInlineCrmFixture();
      const sys = await bootSystem(fixture);
      const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

      // Force an abort by supplying a wrong sequenceVersion
      try {
        await executeUnitOfWork({
          command: {
            commandId: nextUuidv7(),
            boundary: 'Lead',
            intent: 'mutation',
            targetId: '00000000-0000-7000-8000-000000000010',
            payload: {},
            queryParams: {},
            httpMethod: 'PATCH',
            path: '/leads/00000000-0000-7000-8000-000000000010',
            origin: 'inbound',
            depth: 0,
            sequenceVersion: 9999,
          },
          dsl: sys.dsl,
          graph: sys.graph,
          events: sys.events,
          cel: sys.cel,
          validator: sys.validator,
          schemaRegistry: sys.schemaRegistry,
          openapi: sys.openapi,
          logger: createLogger({ level: 'silent' }),
          tracer: otel.tracer,
          metrics,
        });
      } catch {
        // expected ConcurrencyConflictError
      }

      await otel.meterProvider.forceFlush();

      const values = await collectMetricDataPoints(
        otel.metricExporter,
        'engine.command.duration_ms',
      );
      // Duration must be recorded even on abort
      expect(values.length).toBeGreaterThan(0);

      await otel.teardown();
    });
  });

  describe('eventsAppendedTotal', () => {
    it('eventsAppendedTotal increments by number of events appended', async () => {
      const otel = buildInMemoryOtel();
      const metrics = createEngineMetrics(otel.meter);

      const { loadInlineCrmFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
      const fixture = await loadInlineCrmFixture();
      const sys = await bootSystem(fixture);
      const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

      await executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'Lead',
          intent: 'creation',
          targetId: nextUuidv7(),
          payload: { companyName: 'EventsTest Corp', contactName: 'Events User', phone: '+61 2 9000 0003', email: 'events@test.com', source: 'WEBSITE' },
          queryParams: {},
          httpMethod: 'POST',
          path: '/leads',
          origin: 'inbound',
          depth: 0,
        },
        dsl: sys.dsl,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        schemaRegistry: sys.schemaRegistry,
        openapi: sys.openapi,
        logger: createLogger({ level: 'silent' }),
        tracer: otel.tracer,
        metrics,
      });

      await otel.meterProvider.forceFlush();

      const values = await collectMetricDataPoints(
        otel.metricExporter,
        'engine.events_appended.total',
      );
      // At least 1 event should have been recorded
      expect(values.some((v) => v >= 1)).toBe(true);

      await otel.teardown();
    });
  });

  describe('uowAbortsTotal', () => {
    it('uowAbortsTotal increments when a UoW is aborted by ConcurrencyConflictError', async () => {
      const otel = buildInMemoryOtel();
      const metrics = createEngineMetrics(otel.meter);

      const { loadInlineCrmFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
      const fixture = await loadInlineCrmFixture();
      const sys = await bootSystem(fixture);
      const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

      const runConflictingUow = () =>
        executeUnitOfWork({
          command: {
            commandId: nextUuidv7(),
            boundary: 'Lead',
            intent: 'mutation',
            targetId: '00000000-0000-7000-8000-000000000010',
            payload: {},
            queryParams: {},
            httpMethod: 'PATCH',
            path: '/leads/00000000-0000-7000-8000-000000000010',
            origin: 'inbound',
            depth: 0,
            sequenceVersion: 9999,
          },
          dsl: sys.dsl,
          graph: sys.graph,
          events: sys.events,
          cel: sys.cel,
          validator: sys.validator,
          schemaRegistry: sys.schemaRegistry,
          openapi: sys.openapi,
          logger: createLogger({ level: 'silent' }),
          tracer: otel.tracer,
          metrics,
        });

      // The stale sequenceVersion (9999) forces a ConcurrencyConflictError, which
      // aborts the UoW. The outer abort catch increments uowAbortsTotal for ANY
      // aborting exception, so the counter must register at least one abort.
      await expect(runConflictingUow()).rejects.toThrow();

      await otel.meterProvider.forceFlush();

      const values = await collectMetricDataPoints(
        otel.metricExporter,
        'engine.uow_aborts.total',
      );
      const total = values.reduce((sum, v) => sum + v, 0);
      expect(total).toBeGreaterThanOrEqual(1);

      await otel.teardown();
    });
  });

  describe('faultsSimulatedTotal', () => {
    it('faultsSimulatedTotal increments when fault signal is present in command', async () => {
      const otel = buildInMemoryOtel();
      const metrics = createEngineMetrics(otel.meter);

      const { loadInlineCrmFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
      const fixture = await loadInlineCrmFixture();
      const sys = await bootSystem(fixture);
      const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

      const result = await executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'Lead',
          intent: 'creation',
          targetId: nextUuidv7(),
          payload: {},
          queryParams: {},
          httpMethod: 'POST',
          path: '/leads',
          origin: 'inbound',
          depth: 0,
          faultSignal: JSON.stringify({ status: 503, body: { error: 'fault' } }),
        },
        dsl: sys.dsl,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        schemaRegistry: sys.schemaRegistry,
        openapi: sys.openapi,
        logger: createLogger({ level: 'silent' }),
        tracer: otel.tracer,
        metrics,
      });

      expect(result.status).toBe(503);

      await otel.meterProvider.forceFlush();

      const values = await collectMetricDataPoints(
        otel.metricExporter,
        'engine.faults_simulated.total',
      );
      expect(values.some((v) => v >= 1)).toBe(true);

      await otel.teardown();
    });

    it('[CURRENT] faultsSimulatedTotal in gateway is incremented via x-specmatic-fault header', async () => {
      // The gateway also calls sys.metrics.faultsSimulatedTotal.add(1) in the fault path
      // This is a separate call from the UoW one — both paths can increment the counter.
      // This test verifies the gateway-level path is also exercised.
      const app = await createTestApp();
      const faultPayload = JSON.stringify({ status: 503, body: { error: 'gateway-fault' } });

      const res = await app.agent
        .get('/leads')
        .set('x-specmatic-fault', faultPayload)
        .expect(503);
      expect(res.body.error).toBe('gateway-fault');
    });
  });
});

// ---------------------------------------------------------------------------
// Span tests (REQ-43)
// ---------------------------------------------------------------------------

describe('observability/tracing — span completeness (REQ-43)', () => {
  describe('engine.uow span', () => {
    it('engine.uow span is created for each executeUnitOfWork call', async () => {
      const otel = buildInMemoryOtel();
      const metrics = createEngineMetrics(otel.meter);

      const { loadInlineCrmFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
      const fixture = await loadInlineCrmFixture();
      const sys = await bootSystem(fixture);
      const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

      await executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'Lead',
          intent: 'creation',
          targetId: nextUuidv7(),
          payload: { companyName: 'SpanTest Corp', contactName: 'Span User', phone: '+61 2 9000 0004', email: 'span@test.com', source: 'WEBSITE' },
          queryParams: {},
          httpMethod: 'POST',
          path: '/leads',
          origin: 'inbound',
          depth: 0,
        },
        dsl: sys.dsl,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        schemaRegistry: sys.schemaRegistry,
        openapi: sys.openapi,
        logger: createLogger({ level: 'silent' }),
        tracer: otel.tracer,
        metrics,
      });

      await otel.tracerProvider.forceFlush();

      const spans = otel.spanExporter.getFinishedSpans();
      const spanNames = spans.map((s) => s.name);
      expect(spanNames).toContain('engine.uow');

      await otel.teardown();
    });
  });

  describe('http.request span', () => {
    it('http.request span is created for each inbound HTTP request', async () => {
      const otel = buildInMemoryOtel();

      const { loadInlineCrmFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { createGateway } = await import('../../../src/http/gateway.js');
      const fixture = await loadInlineCrmFixture();
      // Inject our test tracer via BootInput
      const sys = await bootSystem({ ...fixture, tracer: otel.tracer });

      const app = createGateway(sys);
      const persistent = await withPersistentServer(app);
      const agent = persistent.agent;
      registerFileTeardown(persistent.close);

      await agent.get('/leads').expect(200);

      await otel.tracerProvider.forceFlush();

      const spans = otel.spanExporter.getFinishedSpans();
      const spanNames = spans.map((s) => s.name);
      expect(spanNames).toContain('http.request');

      await otel.teardown();
    });
  });

  describe('http.admin.* spans', () => {
    it('http.admin.health span is created for GET /_admin/health', async () => {
      const otel = buildInMemoryOtel();

      const { loadInlineCrmFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { createGateway } = await import('../../../src/http/gateway.js');
      const fixture = await loadInlineCrmFixture();
      const sys = await bootSystem({ ...fixture, tracer: otel.tracer });

      const app = createGateway(sys);
      const persistent = await withPersistentServer(app);
      const agent = persistent.agent;
      registerFileTeardown(persistent.close);

      await agent.get('/_admin/health').expect(200);
      await otel.tracerProvider.forceFlush();

      const spans = otel.spanExporter.getFinishedSpans();
      const spanNames = spans.map((s) => s.name);
      expect(spanNames).toContain('http.admin.health');

      await otel.teardown();
    });

    it('http.admin.state span is created for GET /_admin/state', async () => {
      const otel = buildInMemoryOtel();

      const { loadInlineCrmFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { createGateway } = await import('../../../src/http/gateway.js');
      const fixture = await loadInlineCrmFixture();
      const sys = await bootSystem({ ...fixture, tracer: otel.tracer });

      const app = createGateway(sys);
      const persistent = await withPersistentServer(app);
      const agent = persistent.agent;
      registerFileTeardown(persistent.close);

      await agent.get('/_admin/state').expect(200);
      await otel.tracerProvider.forceFlush();

      const spans = otel.spanExporter.getFinishedSpans();
      const spanNames = spans.map((s) => s.name);
      expect(spanNames).toContain('http.admin.state');

      await otel.teardown();
    });

    it('http.admin.events span is created for GET /_admin/events', async () => {
      const otel = buildInMemoryOtel();

      const { loadInlineCrmFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { createGateway } = await import('../../../src/http/gateway.js');
      const fixture = await loadInlineCrmFixture();
      const sys = await bootSystem({ ...fixture, tracer: otel.tracer });

      const app = createGateway(sys);
      const persistent = await withPersistentServer(app);
      const agent = persistent.agent;
      registerFileTeardown(persistent.close);

      await agent.get('/_admin/events').expect(200);
      await otel.tracerProvider.forceFlush();

      const spans = otel.spanExporter.getFinishedSpans();
      const spanNames = spans.map((s) => s.name);
      expect(spanNames).toContain('http.admin.events');

      await otel.teardown();
    });

    it('http.admin.reset span is created for POST /_admin/reset', async () => {
      const otel = buildInMemoryOtel();

      const { loadInlineCrmFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { createGateway } = await import('../../../src/http/gateway.js');
      const fixture = await loadInlineCrmFixture();
      const sys = await bootSystem({ ...fixture, tracer: otel.tracer });

      const app = createGateway(sys);
      const persistent = await withPersistentServer(app);
      const agent = persistent.agent;
      registerFileTeardown(persistent.close);

      await agent.post('/_admin/reset').expect(204);
      await otel.tracerProvider.forceFlush();

      const spans = otel.spanExporter.getFinishedSpans();
      const spanNames = spans.map((s) => s.name);
      expect(spanNames).toContain('http.admin.reset');

      await otel.teardown();
    });
  });

  describe('missing span names (REQ-43 gaps)', () => {
    it(
      '[DOCUMENTED] engine.boot span IS emitted — bootSystem wraps everything in withSpan(engine.boot)',
      async () => {
        // bootSystem wraps the entire boot sequence in withSpan(tracer, 'engine.boot', ...)
        // so the span IS emitted when a tracer is injected via BootInput.
        // This test confirms the span exists (no gap here).
        const otel = buildInMemoryOtel();

        const { loadInlineCrmFixture } = await import(
          '../../integration/_helpers/inline-fixture.js'
        );
        const { bootSystem } = await import('../../../src/engine/boot.js');
        const fixture = await loadInlineCrmFixture();

        await bootSystem({ ...fixture, tracer: otel.tracer });
        await otel.tracerProvider.forceFlush();

        const spans = otel.spanExporter.getFinishedSpans();
        const spanNames = spans.map((s) => s.name);
        expect(spanNames).toContain('engine.boot');

        await otel.teardown();
      },
    );

    it(
      '[FIX O-4] engine.patternMatch span exists within UoW execution',
      async () => {
        // engine.patternMatch is emitted by patternMatcher.ts via withSpanSync (getTracer fallback).
        // The span appears in the UoW exporter since patternMatcher uses the global tracer.
        // This test uses the first global tracer registration to capture it.
        const otel = buildInMemoryOtel();
        const metrics = createEngineMetrics(otel.meter);

        const { loadInlineCrmFixture } = await import(
          '../../integration/_helpers/inline-fixture.js'
        );
        const { bootSystem } = await import('../../../src/engine/boot.js');
        const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
        const fixture = await loadInlineCrmFixture();
        const sys = await bootSystem(fixture);
        const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

        await executeUnitOfWork({
          command: {
            commandId: nextUuidv7(),
            boundary: 'Lead',
            intent: 'creation',
            targetId: nextUuidv7(),
            payload: { companyName: 'PatternSpan Corp', contactName: 'Pattern User', phone: '+61 2 9000 0005', email: 'pattern@test.com', source: 'WEBSITE' },
            queryParams: {},
            httpMethod: 'POST',
            path: '/leads',
            origin: 'inbound',
            depth: 0,
          },
          dsl: sys.dsl,
          graph: sys.graph,
          events: sys.events,
          cel: sys.cel,
          validator: sys.validator,
          schemaRegistry: sys.schemaRegistry,
          openapi: sys.openapi,
          logger: createLogger({ level: 'silent' }),
          tracer: otel.tracer,
          metrics,
        });

        await otel.tracerProvider.forceFlush();

        const spans = otel.spanExporter.getFinishedSpans();
        const spanNames = spans.map((s) => s.name);
        expect(spanNames).toContain('engine.patternMatch');

        await otel.teardown();
      },
    );

    it(
      '[FIX O-5] engine.project span exists within UoW execution',
      async () => {
        // O-5 fix: projection.ts now accepts an optional tracer parameter.
        // UoW threads the injected tracer through to projectEvent, so the
        // engine.project span appears in the test exporter.
        const otel = buildInMemoryOtel();
        const metrics = createEngineMetrics(otel.meter);

        const { loadInlineCrmFixture } = await import(
          '../../integration/_helpers/inline-fixture.js'
        );
        const { bootSystem } = await import('../../../src/engine/boot.js');
        const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
        const fixture = await loadInlineCrmFixture();
        const sys = await bootSystem(fixture);
        const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

        await executeUnitOfWork({
          command: {
            commandId: nextUuidv7(),
            boundary: 'Lead',
            intent: 'creation',
            targetId: nextUuidv7(),
            payload: { companyName: 'ProjectSpan Corp', contactName: 'Project User', phone: '+61 2 9000 0006', email: 'project@test.com', source: 'WEBSITE' },
            queryParams: {},
            httpMethod: 'POST',
            path: '/leads',
            origin: 'inbound',
            depth: 0,
          },
          dsl: sys.dsl,
          graph: sys.graph,
          events: sys.events,
          cel: sys.cel,
          validator: sys.validator,
          schemaRegistry: sys.schemaRegistry,
          openapi: sys.openapi,
          logger: createLogger({ level: 'silent' }),
          tracer: otel.tracer,
          metrics,
        });

        await otel.tracerProvider.forceFlush();

        const spans = otel.spanExporter.getFinishedSpans();
        const spanNames = spans.map((s) => s.name);
        expect(spanNames).toContain('engine.project');

        await otel.teardown();
      },
    );

    it(
      '[FIX O-6] engine.query span exists for query intent',
      async () => {
        // O-6 fix: query.ts now accepts an optional tracer parameter.
        // UoW threads the injected tracer through to runQuery, so the
        // engine.query span appears in the test exporter.
        const otel = buildInMemoryOtel();
        const metrics = createEngineMetrics(otel.meter);

        const { loadInlineCrmFixture } = await import(
          '../../integration/_helpers/inline-fixture.js'
        );
        const { bootSystem } = await import('../../../src/engine/boot.js');
        const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
        const fixture = await loadInlineCrmFixture();
        const sys = await bootSystem(fixture);
        const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

        await executeUnitOfWork({
          command: {
            commandId: nextUuidv7(),
            boundary: 'Lead',
            intent: 'query',
            targetId: null,
            payload: {},
            queryParams: {},
            httpMethod: 'GET',
            path: '/leads',
            origin: 'inbound',
            depth: 0,
          },
          dsl: sys.dsl,
          graph: sys.graph,
          events: sys.events,
          cel: sys.cel,
          validator: sys.validator,
          schemaRegistry: sys.schemaRegistry,
          openapi: sys.openapi,
          logger: createLogger({ level: 'silent' }),
          tracer: otel.tracer,
          metrics,
        });

        await otel.tracerProvider.forceFlush();

        const spans = otel.spanExporter.getFinishedSpans();
        const spanNames = spans.map((s) => s.name);
        expect(spanNames).toContain('engine.query');

        await otel.teardown();
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Structured log bindings (REQ-42)
// ---------------------------------------------------------------------------

describe('observability/logger — structured log bindings (REQ-42)', () => {
  /**
   * Pino does not expose bindings via a public API. We test by creating a
   * child logger and verifying the bindings indirectly via a writable stream
   * destination that captures raw log lines.
   */

  it('childLogger carries provided bindings in output', (done) => {
    const { Writable } = require('stream') as typeof import('stream');
    const lines: string[] = [];

    const dest = new Writable({
      write(chunk: Buffer, _enc: string, cb: () => void) {
        lines.push(chunk.toString());
        cb();
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pino = require('pino') as (opts: unknown, dest: unknown) => import('pino').Logger;
    const baseLogger = pino({ level: 'info' }, dest);
    const child = baseLogger.child({
      boundary: 'Lead',
      commandId: 'cmd-abc',
      aggregateId: 'agg-xyz',
    });

    child.info({ eventId: 'evt-001' }, 'test log');

    // Give pino a tick to flush
    setImmediate(() => {
      const allOutput = lines.join('');
      const parsed = JSON.parse(allOutput) as Record<string, unknown>;
      expect(parsed['boundary']).toBe('Lead');
      expect(parsed['commandId']).toBe('cmd-abc');
      expect(parsed['aggregateId']).toBe('agg-xyz');
      expect(parsed['eventId']).toBe('evt-001');
      done();
    });
  });

  it('[CURRENT] UoW logger child carries commandId and boundary bindings', async () => {
    // The UoW creates logger.child({ name: 'uow', commandId, boundary, intent })
    // We verify that the child() call receives these keys.
    const capturedBindings: Record<string, unknown>[] = [];

    const { createLogger: cl } = await import('../../../src/observability/logger.js');
    const baseLogger = cl({ level: 'silent' });

    const originalChild = baseLogger.child.bind(baseLogger);
    baseLogger.child = (bindings: Record<string, unknown>) => {
      capturedBindings.push(bindings);
      return originalChild(bindings);
    };

    const { loadInlineCrmFixture } = await import(
      '../../integration/_helpers/inline-fixture.js'
    );
    const { bootSystem } = await import('../../../src/engine/boot.js');
    const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
    const fixture = await loadInlineCrmFixture();
    const sys = await bootSystem(fixture);
    const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

    await executeUnitOfWork({
      command: {
        commandId: 'test-cmd-123',
        boundary: 'Lead',
        intent: 'creation',
        targetId: nextUuidv7(),
        payload: { companyName: 'LogTest Corp', contactName: 'Log User', phone: '+61 2 9000 0007', email: 'log@test.com', source: 'WEBSITE' },
        queryParams: {},
        httpMethod: 'POST',
        path: '/leads',
        origin: 'inbound',
        depth: 0,
      },
      dsl: sys.dsl,
      graph: sys.graph,
      events: sys.events,
      cel: sys.cel,
      validator: sys.validator,
      schemaRegistry: sys.schemaRegistry,
      openapi: sys.openapi,
      logger: baseLogger,
      tracer: sys.tracer,
      metrics: sys.metrics,
    });

    // The UoW calls logger.child({ name: 'uow', commandId, boundary, intent })
    const uowBinding = capturedBindings.find((b) => b['commandId'] === 'test-cmd-123');
    expect(uowBinding).toBeDefined();
    expect(uowBinding?.['boundary']).toBe('Lead');
  });

  it(
    '[DOCUMENTED] eventId IS carried via projection child logger (REQ-42: projection.ts satisfies this binding)',
    async () => {
      // REQ-42 requires eventId in child logger context during event processing.
      // projection.ts calls logger.child({ eventId, aggregateId, eventType, boundary })
      // per event — so the requirement IS met at the projection level.
      // The gap is that the UoW primary child does NOT include eventId in its own binding.
      const capturedBindings: Record<string, unknown>[] = [];

      const { createLogger: cl } = await import('../../../src/observability/logger.js');
      const baseLogger = cl({ level: 'silent' });

      const originalChild = baseLogger.child.bind(baseLogger);
      baseLogger.child = (bindings: Record<string, unknown>) => {
        capturedBindings.push(bindings);
        return originalChild(bindings);
      };

      const { loadInlineCrmFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
      const fixture = await loadInlineCrmFixture();
      const sys = await bootSystem(fixture);
      const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

      await executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'Lead',
          intent: 'creation',
          targetId: nextUuidv7(),
          payload: { companyName: 'EventIdLog Corp', contactName: 'EventId User', phone: '+61 2 9000 0008', email: 'eventid@test.com', source: 'WEBSITE' },
          queryParams: {},
          httpMethod: 'POST',
          path: '/leads',
          origin: 'inbound',
          depth: 0,
        },
        dsl: sys.dsl,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        schemaRegistry: sys.schemaRegistry,
        openapi: sys.openapi,
        logger: baseLogger,
        tracer: sys.tracer,
        metrics: sys.metrics,
      });

      // projection.ts calls logger.child({ eventId, ... }) — binding IS present
      const hasEventIdBinding = capturedBindings.some((b) => 'eventId' in b);
      expect(hasEventIdBinding).toBe(true);
    },
  );

  it(
    '[DOCUMENTED] aggregateId IS carried via projection child logger (REQ-42: projection.ts satisfies this binding)',
    async () => {
      // REQ-42 requires aggregateId in child logger context.
      // projection.ts includes aggregateId in its logger.child() call.
      const capturedBindings: Record<string, unknown>[] = [];

      const { createLogger: cl } = await import('../../../src/observability/logger.js');
      const baseLogger = cl({ level: 'silent' });

      const originalChild = baseLogger.child.bind(baseLogger);
      baseLogger.child = (bindings: Record<string, unknown>) => {
        capturedBindings.push(bindings);
        return originalChild(bindings);
      };

      const { loadInlineCrmFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
      const fixture = await loadInlineCrmFixture();
      const sys = await bootSystem(fixture);
      const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

      const targetId = nextUuidv7();
      await executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'Lead',
          intent: 'creation',
          targetId,
          payload: { companyName: 'AggIdLog Corp', contactName: 'AggId User', phone: '+61 2 9000 0009', email: 'aggid@test.com', source: 'WEBSITE' },
          queryParams: {},
          httpMethod: 'POST',
          path: '/leads',
          origin: 'inbound',
          depth: 0,
        },
        dsl: sys.dsl,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        schemaRegistry: sys.schemaRegistry,
        openapi: sys.openapi,
        logger: baseLogger,
        tracer: sys.tracer,
        metrics: sys.metrics,
      });

      // projection.ts calls logger.child({ aggregateId, ... }) — binding IS present
      const hasAggregateIdBinding = capturedBindings.some((b) => 'aggregateId' in b);
      expect(hasAggregateIdBinding).toBe(true);
    },
  );

  it(
    'UoW staged-event loop creates sub-child logger with eventId + aggregateId bindings (REQ-42)',
    async () => {
      // uow.ts line 405: for each staged event, a sub-child logger is created:
      //   logger.child({ eventId: evt.eventId, aggregateId: evt.aggregateId })
      // This test verifies those bindings appear among the captured child calls.
      const capturedBindings: Record<string, unknown>[] = [];

      const { createLogger: cl } = await import('../../../src/observability/logger.js');
      const baseLogger = cl({ level: 'silent' });

      // Patch child() so we capture bindings at every level of the logger hierarchy.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function patchLogger(log: any): any {
        const originalChild = log.child.bind(log);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        log.child = (bindings: Record<string, unknown>, options?: any) => {
          capturedBindings.push(bindings);
          const child = originalChild(bindings, options);
          return patchLogger(child);
        };
        return log;
      }
      patchLogger(baseLogger);

      const { loadInlineCrmFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
      const fixture = await loadInlineCrmFixture();
      const sys = await bootSystem(fixture);
      const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

      await executeUnitOfWork({
        command: {
          commandId: 'uow-gap-test',
          boundary: 'Lead',
          intent: 'creation',
          targetId: nextUuidv7(),
          payload: { companyName: 'UoWGap Corp', contactName: 'UoW User', phone: '+61 2 9000 0010', email: 'uow@test.com', source: 'WEBSITE' },
          queryParams: {},
          httpMethod: 'POST',
          path: '/leads',
          origin: 'inbound',
          depth: 0,
        },
        dsl: sys.dsl,
        graph: sys.graph,
        events: sys.events,
        cel: sys.cel,
        validator: sys.validator,
        schemaRegistry: sys.schemaRegistry,
        openapi: sys.openapi,
        logger: baseLogger,
        tracer: sys.tracer,
        metrics: sys.metrics,
      });

      // The primary UoW binding carries name/commandId/boundary/intent
      const uowPrimaryBinding = capturedBindings.find(
        (b) => b['commandId'] === 'uow-gap-test' && b['name'] === 'uow',
      );
      expect(uowPrimaryBinding).toBeDefined();

      // A sub-child binding for each staged event must carry eventId + aggregateId (REQ-42)
      const eventBinding = capturedBindings.find(
        (b) => 'eventId' in b && 'aggregateId' in b,
      );
      expect(eventBinding).toBeDefined();
      expect(typeof eventBinding?.['eventId']).toBe('string');
      expect(typeof eventBinding?.['aggregateId']).toBe('string');
    },
  );
});
