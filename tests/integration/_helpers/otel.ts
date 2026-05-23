/**
 * In-memory OTel helpers for integration tests that assert spans and metrics.
 *
 * Usage:
 *   const { spanExporter, metricExporter, getMeterProvider, teardown } = createInMemoryOtel();
 *
 *   // build metrics against the returned meter provider
 *   const metrics = createEngineMetrics(getMeterProvider().getMeter('test'));
 *
 *   // after the operation:
 *   await teardown();
 *   const spans  = spanExporter.getFinishedSpans();
 *   const metrics = await metricExporter.collect();
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
} from '@opentelemetry/sdk-metrics';
import { AggregationTemporality } from '@opentelemetry/sdk-metrics';

export interface InMemoryOtel {
  readonly spanExporter: InMemorySpanExporter;
  readonly metricExporter: InMemoryMetricExporter;
  readonly tracerProvider: BasicTracerProvider;
  readonly meterProvider: MeterProvider;
  teardown(): Promise<void>;
}

/**
 * Create an isolated, in-memory OTel environment suitable for a single test run.
 * Spans and metric data are accumulated in memory; call teardown() to flush and
 * shut down the providers cleanly.
 */
export function createInMemoryOtel(): InMemoryOtel {
  // ── Tracing ──────────────────────────────────────────────────────────────
  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider();
  tracerProvider.addSpanProcessor(new SimpleSpanProcessor(spanExporter));

  // ── Metrics ──────────────────────────────────────────────────────────────
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const meterProvider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 100,
      }),
    ],
  });

  return {
    spanExporter,
    metricExporter,
    tracerProvider,
    meterProvider,
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

/**
 * Collect the current data points for a named metric from the MetricExporter.
 * Returns an empty array if no data points exist for that metric yet.
 */
export async function collectMetricDataPoints(
  exporter: InMemoryMetricExporter,
  metricName: string,
): Promise<number[]> {
  const resourceMetrics = exporter.getMetrics();
  const values: number[] = [];

  for (const rm of resourceMetrics) {
    for (const sm of rm.scopeMetrics) {
      for (const metric of sm.metrics) {
        if (metric.descriptor.name === metricName) {
          for (const dp of metric.dataPoints) {
            // Counter / Sum data points store their value in dp.value
            values.push(dp.value as number);
          }
        }
      }
    }
  }

  return values;
}
