import {
  INVALID_SPAN_CONTEXT,
  metrics as apiMetrics,
  trace,
  SpanStatusCode,
} from '@opentelemetry/api';
import type { Attributes, Context, Meter, Span, SpanOptions, Tracer } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_INSTANCE_ID } from '@opentelemetry/semantic-conventions';
// The browser HTTP implementations use the platform fetch API, which is also
// the stable Node 18+ transport and remains usable inside Jest VM contexts.
// The Node implementations dynamically import `node:http`, which cannot be
// evaluated by ts-jest's CommonJS VM without `--experimental-vm-modules`.
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http/build/src/platform/browser/OTLPTraceExporter';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http/build/src/platform/browser/OTLPMetricExporter';
import { metrics as sdkMetrics } from '@opentelemetry/sdk-node';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { randomUUID } from 'node:crypto';
import { v7 } from 'uuid';
import { createNoopLogger, type Logger } from './logger.js';

function loadServiceVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg: unknown = require('../../package.json');
    return isVersionMetadata(pkg) ? (pkg.version ?? 'unknown') : 'unknown';
  } catch {
    return 'unknown';
  }
}

function isVersionMetadata(value: unknown): value is { readonly version?: string } {
  return (
    value !== null &&
    typeof value === 'object' &&
    'version' in value &&
    (value.version === undefined || typeof value.version === 'string')
  );
}

const serviceVersion = loadServiceVersion();

export type { Tracer, Span };
export { SpanStatusCode };

/**
 * Inert tracer for standalone library calls. A host that wants OpenTelemetry
 * observations supplies a tracer explicitly; this fallback does not consult
 * the process-global OpenTelemetry provider.
 */
export function createNoopTracer(): Tracer {
  const span: Span = {
    spanContext: () => INVALID_SPAN_CONTEXT,
    setAttribute(_key, _value) {
      return this;
    },
    setAttributes(_attributes) {
      return this;
    },
    addEvent(_name, _attributesOrStartTime, _startTime) {
      return this;
    },
    addLink(_link) {
      return this;
    },
    addLinks(_links) {
      return this;
    },
    setStatus(_status) {
      return this;
    },
    updateName(_name) {
      return this;
    },
    end() {},
    isRecording: () => false,
    recordException(_exception, _time) {},
  };

  type SpanCallback = (activeSpan: Span) => unknown;

  function resolveSpanCallback(
    optionsOrCallback: SpanOptions | SpanCallback,
    contextOrCallback: Context | SpanCallback | undefined,
    callback: SpanCallback | undefined,
  ): SpanCallback {
    const activeCallback =
      callback ??
      (typeof contextOrCallback === 'function' ? contextOrCallback : undefined) ??
      (typeof optionsOrCallback === 'function' ? optionsOrCallback : undefined);
    if (activeCallback === undefined) throw new TypeError('A span callback is required');
    return activeCallback;
  }

  function startActiveSpan<F extends SpanCallback>(_name: string, fn: F): ReturnType<F>;
  function startActiveSpan<F extends SpanCallback>(
    _name: string,
    _options: SpanOptions,
    fn: F,
  ): ReturnType<F>;
  function startActiveSpan<F extends SpanCallback>(
    _name: string,
    _options: SpanOptions,
    _context: Context,
    fn: F,
  ): ReturnType<F>;
  function startActiveSpan(
    _name: string,
    optionsOrCallback: SpanOptions | SpanCallback,
    contextOrCallback?: Context | SpanCallback,
    callback?: SpanCallback,
  ): unknown {
    return resolveSpanCallback(optionsOrCallback, contextOrCallback, callback)(span);
  }

  return { startSpan: () => span, startActiveSpan };
}

export interface TracingOptions {
  readonly serviceName?: string;
  /** Overrides OTEL_EXPORTER_OTLP_ENDPOINT env var. */
  readonly otlpEndpoint?: string;
  /** Default true unless OTEL_SDK_DISABLED=true env var is set. */
  readonly enabled?: boolean;
  /** Host-provided environment values used only for tracing defaults. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Host-provided diagnostic sink for best-effort tracing warnings. */
  readonly logger?: Logger;
  /** Use synchronous export when a host needs deterministic export assertions. */
  readonly spanProcessor?: 'batch' | 'simple';
  /** Optional metric export interval, primarily for deterministic host tests. */
  readonly metricExportIntervalMs?: number;
}

export interface TracingHandle {
  readonly tracer: Tracer;
  readonly meter: Meter;
  readonly shutdown: () => Promise<void>;
}

function disabledTracingHandle(): TracingHandle {
  return {
    tracer: trace.getTracer('potemkin'),
    meter: apiMetrics.getMeter('potemkin'),
    shutdown: async () => undefined,
  };
}

export async function initTracing(opts?: TracingOptions): Promise<TracingHandle> {
  const env = opts?.env ?? {};
  const logger = opts?.logger ?? createNoopLogger();
  const sdkDisabledEnv = env['OTEL_SDK_DISABLED'] === 'true';
  const enabled = opts?.enabled !== undefined ? opts.enabled : !sdkDisabledEnv;

  if (!enabled) {
    return disabledTracingHandle();
  }

  let instanceId: string;
  try {
    instanceId = v7();
  } catch {
    instanceId = randomUUID();
  }

  const serviceName = opts?.serviceName ?? env['OTEL_SERVICE_NAME'] ?? 'potemkin';
  const otlpEndpoint = opts?.otlpEndpoint ?? env['OTEL_EXPORTER_OTLP_ENDPOINT'];

  if (!otlpEndpoint) {
    logger.warn(
      { serviceName },
      'OTEL tracing is best-effort / disabled: no OTLP endpoint configured. ' +
        'Set OTEL_EXPORTER_OTLP_ENDPOINT or pass opts.otlpEndpoint to enable export.',
    );
    return disabledTracingHandle();
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    'service.version': serviceVersion,
    [ATTR_SERVICE_INSTANCE_ID]: instanceId,
  });

  const traceExporter = new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` });
  const spanProcessor =
    opts?.spanProcessor === 'simple' ? new SimpleSpanProcessor(traceExporter) : undefined;

  const sdk = new NodeSDK({
    resource,
    traceExporter,
    ...(spanProcessor === undefined ? {} : { spanProcessors: [spanProcessor] }),
    metricReader: new sdkMetrics.PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${otlpEndpoint}/v1/metrics` }),
      ...(opts?.metricExportIntervalMs === undefined
        ? {}
        : { exportIntervalMillis: opts.metricExportIntervalMs }),
    }),
    instrumentations: [getNodeAutoInstrumentations()],
  });

  try {
    sdk.start();
  } catch (err) {
    logger.warn({ err, serviceName }, 'OTEL SDK start failed; tracing is best-effort / disabled.');
    return disabledTracingHandle();
  }

  return {
    tracer: trace.getTracer(serviceName),
    meter: apiMetrics.getMeter(serviceName),
    shutdown: async () => {
      try {
        await sdk.shutdown();
      } finally {
        // NodeSDK shuts down its providers but does not clear the API globals.
        // Clear both registries so an in-process host can restart tracing (as
        // the reload/restart lifecycle does) without retaining a dead provider.
        trace.disable();
        apiMetrics.disable();
      }
    },
  };
}

export function getTracer(name?: string): Tracer {
  return trace.getTracer(name ?? 'potemkin');
}

export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  fn: (span: Span) => Promise<T> | T,
  attrs?: Attributes,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span: Span) => {
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v !== undefined) span.setAttribute(k, v);
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
