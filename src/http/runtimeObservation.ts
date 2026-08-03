import type { NextFunction, Request, Response } from "express";
import type { Express } from "express";
import type { RuntimeSystem } from "../runtime/system.js";
import type { JsonValue } from "../types.js";
import type {
  RuntimeCaptureDirection,
  RuntimeCapturedBody,
  RuntimeRequestResponseCapturePolicy,
  RuntimeTransportObservation,
} from "../model/runtime.js";
import { parseControlHeaders } from "./controlHeaders.js";

/**
 * The request that the transport actually handed to the runtime. For the
 * Specmatic endpoint this is the nested HTTP request in the forwarding
 * envelope, rather than the envelope's own POST /_engine/forward request.
 */
export interface RuntimeTransportRequestInput {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string | readonly string[]>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: JsonValue;
}

/**
 * Immutable request metadata captured before Express parsing or runtime
 * execution begins. The transport observer must describe what arrived on the
 * wire, even when a later parser, validator, or runtime step mutates its
 * working request object.
 */
interface RuntimeTransportRequestSnapshot {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string | readonly string[]>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly contentType?: string;
}

export function queryOf(request: Request): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [name, raw] of Object.entries(request.query)) {
    if (typeof raw === "string") result[name] = raw;
    else if (Array.isArray(raw))
      result[name] = raw.filter((value): value is string => typeof value === "string");
    else if (raw !== undefined && raw !== null) result[name] = String(raw);
  }
  return result;
}

export function headersOf(request: Request): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, raw] of Object.entries(request.headers)) {
    if (typeof raw === "string") result[name.toLowerCase()] = raw;
    else if (Array.isArray(raw)) result[name.toLowerCase()] = raw[0] ?? "";
  }
  return result;
}

function responseHeadersOf(response: Response): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, raw] of Object.entries(response.getHeaders())) {
    if (Array.isArray(raw))
      result[name.toLowerCase()] = raw.map((value) => String(value)).join(", ");
    else if (raw !== undefined) result[name.toLowerCase()] = String(raw);
  }
  return result;
}

function decodeUtf8Prefix(encoded: Uint8Array, maxBytes: number): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = Math.max(0, Math.floor(maxBytes)); end >= 0; end -= 1) {
    try {
      return decoder.decode(encoded.slice(0, end));
    } catch {
      /* back up to a code-point boundary */
    }
  }
  return "";
}

function captureTransportBody(
  body: JsonValue | null,
  direction: RuntimeCaptureDirection,
  policy: RuntimeRequestResponseCapturePolicy | undefined,
  rawSerialised?: string,
): RuntimeCapturedBody {
  if (policy === undefined) return { captured: false, bytes: 0, truncated: false };
  // The observer receives a detached value. A redaction strategy is allowed
  // to be imperative, so it must never be able to mutate the captured request
  // or response object held by the gateway/runtime.
  const detached = body === null ? null : structuredClone(body);
  const redacted = policy.redact === undefined ? detached : policy.redact(direction, detached);
  const serialised =
    rawSerialised !== undefined && policy.redact === undefined
      ? rawSerialised
      : JSON.stringify(redacted);
  const encoded = new TextEncoder().encode(serialised);
  const maxBytes = Number.isFinite(policy.maxBytes) ? Math.max(0, Math.floor(policy.maxBytes)) : 0;
  if (encoded.byteLength <= maxBytes)
    return { captured: true, value: redacted, bytes: encoded.byteLength, truncated: false };
  return {
    captured: true,
    value: decodeUtf8Prefix(encoded, maxBytes),
    bytes: encoded.byteLength,
    truncated: true,
  };
}

function captureParsedRequestBody(request: Request, response: Response, buffer: Buffer): void {
  if (response.locals.potemkinCaptureRawRequestBody !== true) return;
  response.locals.potemkinRawRequestBody = buffer.toString("utf8");
}

function requestBodyForObservation(
  request: Request,
  response: Response,
  snapshot: RuntimeTransportRequestSnapshot,
): { readonly body: JsonValue; readonly raw?: string } {
  const raw =
    typeof response.locals.potemkinRawRequestBody === "string"
      ? response.locals.potemkinRawRequestBody
      : undefined;
  const contentType = snapshot.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    raw !== undefined &&
    (contentType === undefined || contentType === "" || contentType.includes("json"))
  ) {
    if (raw === "") return { body: {}, raw };
    try {
      return { body: structuredClone(JSON.parse(raw) as JsonValue), raw };
    } catch {
      // Preserve malformed input as a bounded string for the transport
      // observer; the normal Express error handler still returns the parser's
      // 400 result.
      return { body: raw, raw };
    }
  }
  if (request.body !== undefined) {
    return {
      body: structuredClone(request.body as JsonValue),
      ...(raw === undefined ? {} : { raw }),
    };
  }
  if (raw === undefined || raw === "") return { body: {} };
  try {
    return { body: JSON.parse(raw) as JsonValue, raw };
  } catch {
    // Preserve malformed input as a bounded string for the transport observer;
    // the normal Express error handler still returns the parser's 400 result.
    return { body: raw, raw };
  }
}

export function installRuntimeObservation(app: Express, system: RuntimeSystem): void {
  app.use((request: Request, response: Response, next: NextFunction) => {
    const observer = system.program.dependencies.observability?.observeTransportRequestResponse;
    if (observer === undefined) {
      next();
      return;
    }
    const policy = system.program.dependencies.observability?.requestResponseCapture;
    const inboundHeaders = Object.freeze(headersOf(request));
    const inboundQuery = Object.freeze(
      Object.fromEntries(
        Object.entries(queryOf(request)).map(([name, value]) => [
          name,
          Array.isArray(value) ? Object.freeze([...value]) : value,
        ]),
      ),
    ) as Readonly<Record<string, string | readonly string[]>>;
    const inboundSnapshot: RuntimeTransportRequestSnapshot = Object.freeze({
      method: request.method.toUpperCase(),
      path: request.originalUrl.split("?")[0] ?? request.path,
      query: inboundQuery,
      headers: inboundHeaders,
      ...(typeof inboundHeaders["content-type"] === "string"
        ? { contentType: inboundHeaders["content-type"] }
        : {}),
    });
    response.locals.potemkinCaptureRawRequestBody = policy !== undefined;
    let outgoingBody: JsonValue | null = null;
    let outgoingSerialised: string | undefined;
    let observed = false;
    const record = (connectionClosed: boolean): void => {
      if (observed) return;
      observed = true;
      const transportRequest = response.locals.potemkinTransportRequest as
        | RuntimeTransportRequestInput
        | undefined;
      const inbound =
        transportRequest === undefined
          ? (() => {
              const inboundBody = requestBodyForObservation(request, response, inboundSnapshot);
              return {
                method: inboundSnapshot.method,
                path: inboundSnapshot.path,
                query: inboundSnapshot.query,
                headers: inboundSnapshot.headers,
                body: captureTransportBody(inboundBody.body, "request", policy, inboundBody.raw),
              };
            })()
          : {
              method: transportRequest.method.toUpperCase(),
              path: transportRequest.path,
              query: transportRequest.query,
              headers: transportRequest.headers,
              body: captureTransportBody(transportRequest.body, "request", policy),
            };
      const parsed = parseControlHeaders(
        request.headers as Record<string, string | string[] | undefined>,
      );
      const transportResponseBody = response.locals.potemkinTransportResponseBody as
        | JsonValue
        | null
        | undefined;
      const hasTransportResponseBody = transportResponseBody !== undefined;
      const observedBody = hasTransportResponseBody
        ? transportResponseBody
        : (response.locals.potemkinObservedBody ?? outgoingBody);
      const traceId =
        typeof response.locals.potemkinTraceId === "string"
          ? response.locals.potemkinTraceId
          : parsed.observability.traceId;
      const observation: RuntimeTransportObservation = {
        request: inbound,
        response: {
          status: response.statusCode,
          headers: responseHeadersOf(response),
          body: captureTransportBody(
            observedBody,
            "response",
            policy,
            hasTransportResponseBody || response.locals.potemkinObservedBody !== undefined
              ? undefined
              : outgoingSerialised,
          ),
          ...(connectionClosed ? { connectionClosed: true } : {}),
        },
        correlation: {
          ...(traceId === undefined ? {} : { traceId }),
          ...(typeof response.locals.potemkinCommandId === "string"
            ? { commandId: response.locals.potemkinCommandId }
            : {}),
        },
      };
      Promise.resolve(observer(observation)).catch((error: unknown) => {
        system.program.dependencies.observability?.log?.(
          "error",
          "Transport request/response observation failed",
          { error: String(error) },
        );
      });
    };
    const originalJson = response.json.bind(response);
    response.json = ((body: unknown) => {
      outgoingBody = body === undefined ? null : (body as JsonValue);
      return originalJson(body as never);
    }) as Response["json"];
    const originalEnd = response.end.bind(response);
    response.end = ((chunk?: unknown, encoding?: unknown, callback?: unknown) => {
      if (chunk === undefined || chunk === null || chunk === "") {
        outgoingBody = null;
        outgoingSerialised = undefined;
      } else if (Buffer.isBuffer(chunk)) {
        const text = chunk.toString(
          typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8",
        );
        outgoingSerialised = text;
        try {
          outgoingBody = JSON.parse(text) as JsonValue;
        } catch {
          outgoingBody = text;
        }
      } else if (typeof chunk === "string") {
        outgoingSerialised = chunk;
        try {
          outgoingBody = JSON.parse(chunk) as JsonValue;
        } catch {
          outgoingBody = chunk;
        }
      }
      return originalEnd(chunk as never, encoding as never, callback as never);
    }) as Response["end"];
    response.once("finish", () => record(false));
    response.once("close", () => {
      if (!response.writableEnded) record(true);
    });
    next();
  });
}

export { captureParsedRequestBody };
