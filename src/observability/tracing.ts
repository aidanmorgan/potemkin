import {
  trace,
  SpanStatusCode,
} from '@opentelemetry/api';
import type { Tracer, Span } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_INSTANCE_ID,
} from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { metrics as sdkMetrics } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { randomUUID } from 'node:crypto';
import { nextUuidv7 } from '../ids/uuidv7.js';
import { rootLogger } from './logger.js';

// Pull version from package.json at module load time (best-effort).
let _serviceVersion = 'unknown';
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pkg = require('../../package.json') as { version?: string };
  _serviceVersion = pkg.version ?? 'unknown';
} catch {
  // ignore
}

export type { Tracer, Span };
export { SpanStatusCode };

export interface TracingOptions {
  readonly serviceName?: string;
  /** Overrides OTEL_EXPORTER_OTLP_ENDPOINT env var. */
  readonly otlpEndpoint?: string;
  /** Default true unless OTEL_SDK_DISABLED=true env var is set. */
  readonly enabled?: boolean;
}

export async function initTracing(
  opts?: TracingOptions,
): Promise<{ shutdown: () => Promise<void> }> {
  const sdkDisabledEnv = process.env['OTEL_SDK_DISABLED'] === 'true';
  const enabled = opts?.enabled !== undefined ? opts.enabled : !sdkDisabledEnv;

  if (!enabled) {
    return { shutdown: async () => undefined };
  }

  let instanceId: string;
  try {
    instanceId = nextUuidv7();
  } catch {
    instanceId = randomUUID();
  }

  const serviceName = opts?.serviceName ?? process.env['OTEL_SERVICE_NAME'] ?? 'specmatic-stateful-sim';
  const otlpEndpoint =
    opts?.otlpEndpoint ?? process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];

  if (!otlpEndpoint) {
    rootLogger().warn(
      { serviceName },
      'OTEL tracing is best-effort / disabled: no OTLP endpoint configured. ' +
      'Set OTEL_EXPORTER_OTLP_ENDPOINT or pass opts.otlpEndpoint to enable export.',
    );
    return { shutdown: async () => undefined };
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    'service.version': _serviceVersion,
    [ATTR_SERVICE_INSTANCE_ID]: instanceId,
  });

  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` }),
    metricReader: new sdkMetrics.PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${otlpEndpoint}/v1/metrics` }),
    }),
    instrumentations: [getNodeAutoInstrumentations()],
  });

  try {
    sdk.start();
  } catch (err) {
    rootLogger().warn({ err, serviceName }, 'OTEL SDK start failed; tracing is best-effort / disabled.');
    return { shutdown: async () => undefined };
  }

  return {
    shutdown: async () => {
      await sdk.shutdown();
    },
  };
}

export function getTracer(name?: string): Tracer {
  return trace.getTracer(name ?? 'specmatic-stateful-sim');
}

export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  fn: (span: Span) => Promise<T> | T,
  attrs?: Record<string, unknown>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span: Span) => {
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        span.setAttribute(k, v as string | number | boolean);
      }
    }
    try {
      const result = await fn(span);
      return result;
    } catch (err) {
      recordException(span, err);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

export function recordException(span: Span, err: unknown): void {
  if (err instanceof Error) {
    span.recordException(err);
  } else {
    span.recordException(String(err));
  }
  span.setStatus({ code: SpanStatusCode.ERROR });
}
