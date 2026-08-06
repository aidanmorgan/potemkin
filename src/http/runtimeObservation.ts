import type { NextFunction, Request, Response } from 'express';
import type { Express } from 'express';
import type { RuntimeSystem } from '../runtime/system.js';
import { isJsonValue, type JsonValue } from '../contracts/value.js';
import { CommandId, httpMethod, type HttpMethod } from '../domain/references.js';
import type {
  RuntimeCaptureDirection,
  RuntimeCapturedBody,
  RuntimeRequestResponseCapturePolicy,
  RuntimeTransportRequest,
  RuntimeTransportObservation,
} from '../contracts/ports.js';
import { parseControlHeaders } from './controlHeaders.js';

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

/** Express locals owned by the runtime transport observer and gateway. */
export interface RuntimeObservationLocals {
  potemkinCaptureRawRequestBody?: boolean;
  potemkinRawRequestBody?: string;
  potemkinTransportRequest?: RuntimeTransportRequestInput;
  potemkinTransportResponseBody?: JsonValue | null;
  potemkinObservedBody?: JsonValue | null;
  potemkinTraceId?: string;
  potemkinCommandId?: string;
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

/** Convert raw transport metadata into the runtime's supported HTTP vocabulary. */
export function normalizeRuntimeTransportMethod(raw: string): HttpMethod {
  return httpMethod(raw);
}

function observedTransportRequest(
  method: string,
  path: string,
  query: Readonly<Record<string, string | readonly string[]>>,
  headers: Readonly<Record<string, string>>,
  body: RuntimeCapturedBody,
): RuntimeTransportRequest {
  return {
    method: normalizeRuntimeTransportMethod(method),
    path,
    query,
    headers,
    body,
  };
}

export function queryOf(request: Request): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [name, raw] of Object.entries(request.query)) {
    if (typeof raw === 'string') result[name] = raw;
    else if (Array.isArray(raw))
      result[name] = raw.filter((value): value is string => typeof value === 'string');
    else if (raw !== undefined && raw !== null) result[name] = String(raw);
  }
  return result;
}

export function headersOf(request: Request): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, raw] of Object.entries(request.headers)) {
    if (typeof raw === 'string') result[name.toLowerCase()] = raw;
    else if (Array.isArray(raw)) result[name.toLowerCase()] = raw[0] ?? '';
  }
  return result;
}

function responseHeadersOf(response: Response): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, raw] of Object.entries(response.getHeaders())) {
    if (Array.isArray(raw))
      result[name.toLowerCase()] = raw.map((value) => String(value)).join(', ');
    else if (raw !== undefined) result[name.toLowerCase()] = String(raw);
  }
  return result;
}

function decodeUtf8Prefix(encoded: Uint8Array, maxBytes: number): string {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = Math.max(0, Math.floor(maxBytes)); end >= 0; end -= 1) {
    try {
      return decoder.decode(encoded.slice(0, end));
    } catch {
      /* back up to a code-point boundary */
    }
  }
  return '';
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

function captureParsedRequestBody(
  _request: Request,
  response: Response<unknown, RuntimeObservationLocals>,
  buffer: Buffer,
): void {
  if (response.locals.potemkinCaptureRawRequestBody !== true) return;
  response.locals.potemkinRawRequestBody = buffer.toString('utf8');
}

function requestBodyForObservation(
  request: Request,
  response: Response<unknown, RuntimeObservationLocals>,
  snapshot: RuntimeTransportRequestSnapshot,
): { readonly body: JsonValue; readonly raw?: string } {
  const raw =
    typeof response.locals.potemkinRawRequestBody === 'string'
      ? response.locals.potemkinRawRequestBody
      : undefined;
  const contentType = snapshot.contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (
    raw !== undefined &&
    (contentType === undefined || contentType === '' || contentType.includes('json'))
  ) {
    if (raw === '') return { body: {}, raw };
    try {
      return { body: structuredClone(parseJsonValue(raw)), raw };
    } catch {
      // Preserve malformed input as a bounded string for the transport
      // observer; the normal Express error handler still returns the parser's
      // 400 result.
      return { body: raw, raw };
    }
  }
  if (request.body !== undefined) {
    const body: unknown = request.body;
    return {
      body: isJsonValue(body) ? structuredClone(body) : {},
      ...(raw === undefined ? {} : { raw }),
    };
  }
  if (raw === undefined || raw === '') return { body: {} };
  try {
    return { body: parseJsonValue(raw), raw };
  } catch {
    // Preserve malformed input as a bounded string for the transport observer;
    // the normal Express error handler still returns the parser's 400 result.
    return { body: raw, raw };
  }
}

function parseJsonValue(raw: string): JsonValue {
  const value: unknown = JSON.parse(raw);
  if (!isJsonValue(value)) throw new Error('Parsed JSON value is not JSON-compatible');
  return value;
}

export function installRuntimeObservation(app: Express, system: RuntimeSystem): void {
  app.use(
    (
      request: Request,
      response: Response<unknown, RuntimeObservationLocals>,
      next: NextFunction,
    ) => {
      const observer = system.program.dependencies.observability?.observeTransportRequestResponse;
      if (observer === undefined) {
        next();
        return;
      }
      const policy = system.program.dependencies.observability?.requestResponseCapture;
      const inboundHeaders = Object.freeze(headersOf(request));
      const inboundQuery: Readonly<Record<string, string | readonly string[]>> = Object.freeze(
        Object.fromEntries(
          Object.entries(queryOf(request)).map(([name, value]) => [
            name,
            Array.isArray(value) ? Object.freeze([...value]) : value,
          ]),
        ),
      );
      const inboundSnapshot: RuntimeTransportRequestSnapshot = Object.freeze({
        method: request.method,
        path: request.originalUrl.split('?')[0] ?? request.path,
        query: inboundQuery,
        headers: inboundHeaders,
        ...(typeof inboundHeaders['content-type'] === 'string'
          ? { contentType: inboundHeaders['content-type'] }
          : {}),
      });
      response.locals.potemkinCaptureRawRequestBody = policy !== undefined;
      let outgoingBody: JsonValue | null = null;
      let outgoingSerialised: string | undefined;
      let observed = false;
      const record = (connectionClosed: boolean): void => {
        if (observed) return;
        observed = true;
        const transportRequest = response.locals.potemkinTransportRequest;
        const inbound: RuntimeTransportRequest =
          transportRequest === undefined
            ? (() => {
                const inboundBody = requestBodyForObservation(request, response, inboundSnapshot);
                return observedTransportRequest(
                  inboundSnapshot.method,
                  inboundSnapshot.path,
                  inboundSnapshot.query,
                  inboundSnapshot.headers,
                  captureTransportBody(inboundBody.body, 'request', policy, inboundBody.raw),
                );
              })()
            : observedTransportRequest(
                transportRequest.method,
                transportRequest.path,
                transportRequest.query,
                transportRequest.headers,
                captureTransportBody(transportRequest.body, 'request', policy),
              );
        const parsed = parseControlHeaders(headersOf(request));
        const transportResponseBody = response.locals.potemkinTransportResponseBody;
        const hasTransportResponseBody = transportResponseBody !== undefined;
        const observedBody = hasTransportResponseBody
          ? transportResponseBody
          : (response.locals.potemkinObservedBody ?? outgoingBody);
        const traceId =
          typeof response.locals.potemkinTraceId === 'string'
            ? response.locals.potemkinTraceId
            : parsed.observability.traceId;
        const observation: RuntimeTransportObservation = {
          request: inbound,
          response: {
            status: response.statusCode,
            headers: responseHeadersOf(response),
            body: captureTransportBody(
              observedBody,
              'response',
              policy,
              hasTransportResponseBody || response.locals.potemkinObservedBody !== undefined
                ? undefined
                : outgoingSerialised,
            ),
            ...(connectionClosed ? { connectionClosed: true } : {}),
          },
          correlation: {
            ...(traceId === undefined ? {} : { traceId }),
            ...(typeof response.locals.potemkinCommandId === 'string'
              ? { commandId: CommandId.parse(response.locals.potemkinCommandId) }
              : {}),
          },
        };
        Promise.resolve(observer(observation)).catch((error: unknown) => {
          system.program.dependencies.observability?.log?.(
            'error',
            'Transport request/response observation failed',
            { error: String(error) },
          );
        });
      };
      const originalJson = response.json.bind(response);
      response.json = (body) => {
        outgoingBody = body === undefined ? null : isJsonValue(body) ? body : null;
        return originalJson(body);
      };
      const originalEnd = response.end.bind(response);
      function observedEnd(this: Response): Response;
      function observedEnd(this: Response, chunk: unknown, callback?: () => void): Response;
      function observedEnd(
        this: Response,
        chunk: unknown,
        encoding: BufferEncoding,
        callback?: () => void,
      ): Response;
      function observedEnd(
        this: Response,
        chunk?: unknown,
        encoding?: BufferEncoding | (() => void),
        callback?: () => void,
      ): Response {
        if (chunk === undefined || chunk === null || chunk === '') {
          outgoingBody = null;
          outgoingSerialised = undefined;
        } else if (Buffer.isBuffer(chunk)) {
          const text = chunk.toString(typeof encoding === 'string' ? encoding : 'utf8');
          outgoingSerialised = text;
          try {
            outgoingBody = parseJsonValue(text);
          } catch {
            outgoingBody = text;
          }
        } else if (typeof chunk === 'string') {
          outgoingSerialised = chunk;
          try {
            outgoingBody = parseJsonValue(chunk);
          } catch {
            outgoingBody = chunk;
          }
        }
        if (typeof encoding === 'string') return originalEnd(chunk, encoding, callback);
        if (typeof encoding === 'function') return originalEnd(chunk, encoding);
        if (chunk === undefined) return originalEnd(callback);
        return originalEnd(chunk, callback);
      }
      response.end = observedEnd;
      response.once('finish', () => record(false));
      response.once('close', () => {
        if (!response.writableEnded) record(true);
      });
      next();
    },
  );
}

export { captureParsedRequestBody };
