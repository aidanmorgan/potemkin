import { trace, SpanStatusCode } from "@opentelemetry/api";
import type { Tracer, Span } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_INSTANCE_ID } from "@opentelemetry/semantic-conventions";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { metrics as sdkMetrics } from "@opentelemetry/sdk-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { randomUUID } from "node:crypto";
import { nextUuidv7 } from "../ids/uuidv7.js";
import { createNoopLogger, type Logger } from "./logger.js";

function loadServiceVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require("../../package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
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
  const span = {
    setAttribute: () => span,
    setAttributes: () => undefined,
    setStatus: () => undefined,
    recordException: () => undefined,
    addEvent: () => span,
    addLink: () => span,
    addLinks: () => span,
    end: () => undefined,
    isRecording: () => false,
    spanContext: () => ({ traceId: "", spanId: "", traceFlags: 0 }),
  } as unknown as Span;

  return {
    startSpan: () => span,
    startActiveSpan: (...args: unknown[]) => {
      const callback = args[args.length - 1];
      if (typeof callback !== "function") throw new TypeError("A span callback is required");
      return callback(span);
    },
  } as unknown as Tracer;
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
  readonly spanProcessor?: "batch" | "simple";
  /** Optional metric export interval, primarily for deterministic host tests. */
  readonly metricExportIntervalMs?: number;
}

export async function initTracing(
  opts?: TracingOptions,
): Promise<{ shutdown: () => Promise<void> }> {
  const env = opts?.env ?? {};
  const logger = opts?.logger ?? createNoopLogger();
  const sdkDisabledEnv = env["OTEL_SDK_DISABLED"] === "true";
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

  const serviceName = opts?.serviceName ?? env["OTEL_SERVICE_NAME"] ?? "potemkin";
  const otlpEndpoint = opts?.otlpEndpoint ?? env["OTEL_EXPORTER_OTLP_ENDPOINT"];

  if (!otlpEndpoint) {
    logger.warn(
      { serviceName },
      "OTEL tracing is best-effort / disabled: no OTLP endpoint configured. " +
        "Set OTEL_EXPORTER_OTLP_ENDPOINT or pass opts.otlpEndpoint to enable export.",
    );
    return { shutdown: async () => undefined };
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    "service.version": serviceVersion,
    [ATTR_SERVICE_INSTANCE_ID]: instanceId,
  });

  const traceExporter = new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` });
  const spanProcessor =
    opts?.spanProcessor === "simple" ? new SimpleSpanProcessor(traceExporter) : undefined;

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
    logger.warn({ err, serviceName }, "OTEL SDK start failed; tracing is best-effort / disabled.");
    return { shutdown: async () => undefined };
  }

  return {
    shutdown: async () => {
      await sdk.shutdown();
    },
  };
}

export function getTracer(name?: string): Tracer {
  return trace.getTracer(name ?? "potemkin");
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
