import { trace } from "@opentelemetry/api";
import type { Span, Tracer } from "@opentelemetry/api";
import type { RuntimeTransportObservation } from "../model/runtime.js";
import { createNoopTracer } from "./tracing.js";

export interface RuntimeOtelRequestResponseOptions {
  readonly tracer?: Tracer;
  readonly spanName?: string;
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function recordExchange(span: Span, observation: RuntimeTransportObservation): void {
  const { request, response, correlation } = observation;
  span.setAttributes({
    "potemkin.request.method": request.method,
    "potemkin.request.path": request.path,
    "potemkin.request.query": json(request.query),
    "potemkin.request.headers": json(request.headers),
    "potemkin.request.body.captured": request.body.captured,
    "potemkin.request.body.bytes": request.body.bytes,
    "potemkin.request.body.truncated": request.body.truncated,
    "potemkin.response.status": response.status,
    "potemkin.response.headers": json(response.headers),
    "potemkin.response.body.captured": response.body.captured,
    "potemkin.response.body.bytes": response.body.bytes,
    "potemkin.response.body.truncated": response.body.truncated,
    ...(correlation.traceId === undefined ? {} : { "potemkin.trace_id": correlation.traceId }),
    ...(correlation.commandId === undefined
      ? {}
      : { "potemkin.command_id": correlation.commandId }),
    ...(response.connectionClosed === true ? { "potemkin.response.connection_closed": true } : {}),
  });
  if (request.body.captured) span.setAttribute("potemkin.request.body", json(request.body.value));
  if (response.body.captured)
    span.setAttribute("potemkin.response.body", json(response.body.value));
}

/**
 * Adapt the source-independent final transport observation to OpenTelemetry.
 * The HTTP gateway performs redaction and byte limiting before this callback,
 * so this function never captures an unrestricted request or response body.
 */
export function createRuntimeOtelRequestResponseObserver(
  options: RuntimeOtelRequestResponseOptions = {},
): (observation: RuntimeTransportObservation) => void {
  const tracer = options.tracer ?? createNoopTracer();
  const spanName = options.spanName ?? "potemkin.request.response";
  return (observation) => {
    const active = trace.getActiveSpan();
    if (active !== undefined && active.isRecording()) {
      recordExchange(active, observation);
      return;
    }
    tracer.startActiveSpan(spanName, (span) => {
      try {
        recordExchange(span, observation);
      } finally {
        span.end();
      }
    });
  };
}
