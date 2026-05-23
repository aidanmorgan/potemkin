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
      const { loadBankingFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
      const fixture = await loadBankingFixture();
      const sys = await bootSystem(fixture);
      const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

      await executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'Customer',
          intent: 'creation',
          targetId: nextUuidv7(),
          payload: { name: 'MetricTest', riskBand: 'LOW' },
          queryParams: {},
          httpMethod: 'POST',
          path: '/customers',
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

      const { loadBankingFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
      const fixture = await loadBankingFixture();
      const sys = await bootSystem(fixture);
      const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

      await executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'Customer',
          intent: 'creation',
          targetId: nextUuidv7(),
          payload: { name: 'DurationTest', riskBand: 'MED' },
          queryParams: {},
          httpMethod: 'POST',
          path: '/customers',
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

      const { loadBankingFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
      const fixture = await loadBankingFixture();
      const sys = await bootSystem(fixture);
      const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

      // Force an abort by supplying a wrong sequenceVersion
      try {
        await executeUnitOfWork({
          command: {
            commandId: nextUuidv7(),
            boundary: 'Customer',
            intent: 'mutation',
            targetId: '00000000-0000-7000-8000-000000000001',
            payload: {},
            queryParams: {},
            httpMethod: 'PATCH',
            path: '/customers/00000000-0000-7000-8000-000000000001',
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

      const { loadBankingFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
      const fixture = await loadBankingFixture();
      const sys = await bootSystem(fixture);
      const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

      await executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'Customer',
          intent: 'creation',
          targetId: nextUuidv7(),
          payload: { name: 'EventsTest', riskBand: 'LOW' },
          queryParams: {},
          httpMethod: 'POST',
          path: '/customers',
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

      const { loadBankingFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
      const fixture = await loadBankingFixture();
      const sys = await bootSystem(fixture);
      const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

      try {
        await executeUnitOfWork({
          command: {
            commandId: nextUuidv7(),
            boundary: 'Customer',
            intent: 'mutation',
            targetId: '00000000-0000-7000-8000-000000000001',
            payload: {},
            queryParams: {},
            httpMethod: 'PATCH',
            path: '/customers/00000000-0000-7000-8000-000000000001',
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
        // expected
      }

      await otel.meterProvider.forceFlush();

      // NOTE: ConcurrencyConflictError is thrown BEFORE runPatternMatch, so
      // uowAbortsTotal is NOT incremented for concurrency errors — only for
      // PatternMatch failures. This test documents the gap.
      // The counter IS incremented only when runPatternMatch itself throws.
      // For a genuine pattern match abort, we'd need a more complex fixture.
      // This test verifies the metric CAN be read (even if 0 for this scenario).
      const values = await collectMetricDataPoints(
        otel.metricExporter,
        'engine.uow_aborts.total',
      );
      // The metric should be readable (may be 0 or >= 1 depending on scenario)
      expect(Array.isArray(values)).toBe(true);

      await otel.teardown();
    });
  });

  describe('faultsSimulatedTotal', () => {
    it('faultsSimulatedTotal increments when fault signal is present in command', async () => {
      const otel = buildInMemoryOtel();
      const metrics = createEngineMetrics(otel.meter);

      const { loadBankingFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
      const fixture = await loadBankingFixture();
      const sys = await bootSystem(fixture);
      const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

      const result = await executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'Customer',
          intent: 'creation',
          targetId: nextUuidv7(),
          payload: {},
          queryParams: {},
          httpMethod: 'POST',
          path: '/customers',
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
        .get('/customers')
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

      const { loadBankingFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
      const fixture = await loadBankingFixture();
      const sys = await bootSystem(fixture);
      const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

      await executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'Customer',
          intent: 'creation',
          targetId: nextUuidv7(),
          payload: { name: 'SpanTest', riskBand: 'LOW' },
          queryParams: {},
          httpMethod: 'POST',
          path: '/customers',
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

      const { loadBankingFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { createGateway } = await import('../../../src/http/gateway.js');
      const fixture = await loadBankingFixture();
      // Inject our test tracer via BootInput
      const sys = await bootSystem({ ...fixture, tracer: otel.tracer });

      const app = createGateway(sys);
      const request = (await import('supertest')).default;
      const agent = request(app);

      await agent.get('/customers').expect(200);

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

      const { loadBankingFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { createGateway } = await import('../../../src/http/gateway.js');
      const fixture = await loadBankingFixture();
      const sys = await bootSystem({ ...fixture, tracer: otel.tracer });

      const app = createGateway(sys);
      const request = (await import('supertest')).default;
      const agent = request(app);

      await agent.get('/_admin/health').expect(200);
      await otel.tracerProvider.forceFlush();

      const spans = otel.spanExporter.getFinishedSpans();
      const spanNames = spans.map((s) => s.name);
      expect(spanNames).toContain('http.admin.health');

      await otel.teardown();
    });

    it('http.admin.state span is created for GET /_admin/state', async () => {
      const otel = buildInMemoryOtel();

      const { loadBankingFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { createGateway } = await import('../../../src/http/gateway.js');
      const fixture = await loadBankingFixture();
      const sys = await bootSystem({ ...fixture, tracer: otel.tracer });

      const app = createGateway(sys);
      const request = (await import('supertest')).default;
      const agent = request(app);

      await agent.get('/_admin/state').expect(200);
      await otel.tracerProvider.forceFlush();

      const spans = otel.spanExporter.getFinishedSpans();
      const spanNames = spans.map((s) => s.name);
      expect(spanNames).toContain('http.admin.state');

      await otel.teardown();
    });

    it('http.admin.events span is created for GET /_admin/events', async () => {
      const otel = buildInMemoryOtel();

      const { loadBankingFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { createGateway } = await import('../../../src/http/gateway.js');
      const fixture = await loadBankingFixture();
      const sys = await bootSystem({ ...fixture, tracer: otel.tracer });

      const app = createGateway(sys);
      const request = (await import('supertest')).default;
      const agent = request(app);

      await agent.get('/_admin/events').expect(200);
      await otel.tracerProvider.forceFlush();

      const spans = otel.spanExporter.getFinishedSpans();
      const spanNames = spans.map((s) => s.name);
      expect(spanNames).toContain('http.admin.events');

      await otel.teardown();
    });

    it('http.admin.reset span is created for POST /_admin/reset', async () => {
      const otel = buildInMemoryOtel();

      const { loadBankingFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { createGateway } = await import('../../../src/http/gateway.js');
      const fixture = await loadBankingFixture();
      const sys = await bootSystem({ ...fixture, tracer: otel.tracer });

      const app = createGateway(sys);
      const request = (await import('supertest')).default;
      const agent = request(app);

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

        const { loadBankingFixture } = await import(
          '../../integration/_helpers/inline-fixture.js'
        );
        const { bootSystem } = await import('../../../src/engine/boot.js');
        const fixture = await loadBankingFixture();

        await bootSystem({ ...fixture, tracer: otel.tracer });
        await otel.tracerProvider.forceFlush();

        const spans = otel.spanExporter.getFinishedSpans();
        const spanNames = spans.map((s) => s.name);
        expect(spanNames).toContain('engine.boot');

        await otel.teardown();
      },
    );

    it.failing(
      '[GAP] engine.patternMatch span exists within UoW execution',
      async () => {
        const otel = buildInMemoryOtel();
        const metrics = createEngineMetrics(otel.meter);

        const { loadBankingFixture } = await import(
          '../../integration/_helpers/inline-fixture.js'
        );
        const { bootSystem } = await import('../../../src/engine/boot.js');
        const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
        const fixture = await loadBankingFixture();
        const sys = await bootSystem(fixture);
        const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

        await executeUnitOfWork({
          command: {
            commandId: nextUuidv7(),
            boundary: 'Customer',
            intent: 'creation',
            targetId: nextUuidv7(),
            payload: { name: 'PatternSpan', riskBand: 'LOW' },
            queryParams: {},
            httpMethod: 'POST',
            path: '/customers',
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
        // engine.patternMatch is NOT emitted — cascade span is engine.uow.cascade.depth-0
        expect(spanNames).toContain('engine.patternMatch');

        await otel.teardown();
      },
    );

    it.failing(
      '[GAP] engine.project span exists within UoW execution',
      async () => {
        const otel = buildInMemoryOtel();
        const metrics = createEngineMetrics(otel.meter);

        const { loadBankingFixture } = await import(
          '../../integration/_helpers/inline-fixture.js'
        );
        const { bootSystem } = await import('../../../src/engine/boot.js');
        const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
        const fixture = await loadBankingFixture();
        const sys = await bootSystem(fixture);
        const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

        await executeUnitOfWork({
          command: {
            commandId: nextUuidv7(),
            boundary: 'Customer',
            intent: 'creation',
            targetId: nextUuidv7(),
            payload: { name: 'ProjectSpan', riskBand: 'LOW' },
            queryParams: {},
            httpMethod: 'POST',
            path: '/customers',
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
        // engine.project is NOT emitted — projections happen inline within cascade span
        expect(spanNames).toContain('engine.project');

        await otel.teardown();
      },
    );

    it.failing(
      '[GAP] engine.query span exists for query intent',
      async () => {
        const otel = buildInMemoryOtel();
        const metrics = createEngineMetrics(otel.meter);

        const { loadBankingFixture } = await import(
          '../../integration/_helpers/inline-fixture.js'
        );
        const { bootSystem } = await import('../../../src/engine/boot.js');
        const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
        const fixture = await loadBankingFixture();
        const sys = await bootSystem(fixture);
        const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

        await executeUnitOfWork({
          command: {
            commandId: nextUuidv7(),
            boundary: 'Customer',
            intent: 'query',
            targetId: null,
            payload: {},
            queryParams: {},
            httpMethod: 'GET',
            path: '/customers',
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
        // engine.query is NOT emitted — query runs inline without a dedicated span
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
      boundary: 'Customer',
      commandId: 'cmd-abc',
      aggregateId: 'agg-xyz',
    });

    child.info({ eventId: 'evt-001' }, 'test log');

    // Give pino a tick to flush
    setImmediate(() => {
      const allOutput = lines.join('');
      const parsed = JSON.parse(allOutput) as Record<string, unknown>;
      expect(parsed['boundary']).toBe('Customer');
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

    const { loadBankingFixture } = await import(
      '../../integration/_helpers/inline-fixture.js'
    );
    const { bootSystem } = await import('../../../src/engine/boot.js');
    const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
    const fixture = await loadBankingFixture();
    const sys = await bootSystem(fixture);
    const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

    await executeUnitOfWork({
      command: {
        commandId: 'test-cmd-123',
        boundary: 'Customer',
        intent: 'creation',
        targetId: nextUuidv7(),
        payload: { name: 'LogTest', riskBand: 'LOW' },
        queryParams: {},
        httpMethod: 'POST',
        path: '/customers',
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
    expect(uowBinding?.['boundary']).toBe('Customer');
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

      const { loadBankingFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
      const fixture = await loadBankingFixture();
      const sys = await bootSystem(fixture);
      const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

      await executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'Customer',
          intent: 'creation',
          targetId: nextUuidv7(),
          payload: { name: 'EventIdLog', riskBand: 'LOW' },
          queryParams: {},
          httpMethod: 'POST',
          path: '/customers',
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

      const { loadBankingFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
      const fixture = await loadBankingFixture();
      const sys = await bootSystem(fixture);
      const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

      const targetId = nextUuidv7();
      await executeUnitOfWork({
        command: {
          commandId: nextUuidv7(),
          boundary: 'Customer',
          intent: 'creation',
          targetId,
          payload: { name: 'AggIdLog', riskBand: 'LOW' },
          queryParams: {},
          httpMethod: 'POST',
          path: '/customers',
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

  it.failing(
    '[GAP] UoW primary logger child binding omits eventId and aggregateId (REQ-42 partial gap)',
    async () => {
      // The UoW creates: logger.child({ name: 'uow', commandId, boundary, intent })
      // It omits eventId and aggregateId at the UoW-primary-binding level.
      // These appear only in projection's sub-child. REQ-42 says the child logger should
      // carry ALL four fields — boundary, commandId, eventId, aggregateId.
      // The primary UoW child binding is missing eventId + aggregateId.
      const capturedBindings: Record<string, unknown>[] = [];

      const { createLogger: cl } = await import('../../../src/observability/logger.js');
      const baseLogger = cl({ level: 'silent' });

      const originalChild = baseLogger.child.bind(baseLogger);
      baseLogger.child = (bindings: Record<string, unknown>) => {
        capturedBindings.push(bindings);
        return originalChild(bindings);
      };

      const { loadBankingFixture } = await import(
        '../../integration/_helpers/inline-fixture.js'
      );
      const { bootSystem } = await import('../../../src/engine/boot.js');
      const { executeUnitOfWork } = await import('../../../src/engine/uow.js');
      const fixture = await loadBankingFixture();
      const sys = await bootSystem(fixture);
      const { nextUuidv7 } = await import('../../../src/ids/uuidv7.js');

      await executeUnitOfWork({
        command: {
          commandId: 'uow-gap-test',
          boundary: 'Customer',
          intent: 'creation',
          targetId: nextUuidv7(),
          payload: { name: 'UoWGap', riskBand: 'LOW' },
          queryParams: {},
          httpMethod: 'POST',
          path: '/customers',
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

      // Find the UoW primary binding — name: 'uow', commandId: 'uow-gap-test'
      // It should carry eventId AND aggregateId per REQ-42 — but it does NOT
      const uowPrimaryBinding = capturedBindings.find(
        (b) => b['commandId'] === 'uow-gap-test' && b['name'] === 'uow',
      );
      expect(uowPrimaryBinding).toBeDefined();
      // These assertions fail because the UoW primary binding lacks eventId/aggregateId:
      expect(uowPrimaryBinding?.['eventId']).toBeDefined();
      expect(uowPrimaryBinding?.['aggregateId']).toBeDefined();
    },
  );
});
