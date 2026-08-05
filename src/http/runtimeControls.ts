import type { Request } from 'express';
import {
  flattenRuntimeControlDefaults,
  MAX_RUNTIME_DELAY_MS,
  normalizeRuntimeControls,
  type RuntimeControlDefaults,
  type RuntimeControls,
} from '../model/runtime.js';
import { parseControlHeaders } from './controlHeaders.js';
import {
  POTEMKIN_BODY_TRUNCATE,
  POTEMKIN_DROP_CONNECTION,
  POTEMKIN_ERROR_CLASS,
  POTEMKIN_FORCE_LATENCY,
  POTEMKIN_FORCE_RESPONSE,
  POTEMKIN_FORCE_STATUS,
  POTEMKIN_JITTER,
  POTEMKIN_RATE_LIMIT,
  POTEMKIN_RETRY_AFTER,
  POTEMKIN_SCENARIO,
  POTEMKIN_SIGNAL,
  POTEMKIN_SLOW_RESPONSE,
  POTEMKIN_SUCCESS_RATE,
  POTEMKIN_USE_FAULT,
  POTEMKIN_FEATURE_FLAG,
} from './potemkinHeaders.js';

export type RuntimeHeaderValues = Record<string, string | string[] | undefined>;

function headerValue(headers: RuntimeHeaderValues, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted)?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function boundedNonNegative(value: string | undefined, maximum?: number): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && (maximum === undefined || number <= maximum)
    ? number
    : undefined;
}

function jitterRange(
  value: string | undefined,
): Readonly<{ min: number; max: number }> | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const rawParts = value.split(':');
  if (rawParts.some((part) => part.trim() === '')) return undefined;
  const parts = rawParts.map(Number);
  if (
    (parts.length !== 1 && parts.length !== 2) ||
    parts.some((part) => !Number.isFinite(part) || part < 0 || part > MAX_RUNTIME_DELAY_MS)
  ) {
    return undefined;
  }
  const min = parts.length === 2 ? parts[0]! : 0;
  const max = parts.at(-1)!;
  return max < min ? undefined : { min, max };
}

/** Convert wire controls into the same runtime controls used by direct authoring. */
export function controlsFromHeaders(
  headers: RuntimeHeaderValues,
  defaults?: RuntimeControlDefaults,
): RuntimeControls {
  const parsed = parseControlHeaders(headers);
  const forceStatus = boundedNonNegative(headerValue(headers, POTEMKIN_FORCE_STATUS));
  const errorClass = headerValue(headers, POTEMKIN_ERROR_CLASS)?.toLowerCase();
  const signal = headerValue(headers, POTEMKIN_SIGNAL)?.trim().toLowerCase();
  const rateLimit = headerValue(headers, POTEMKIN_RATE_LIMIT)?.trim().toLowerCase();
  const jitter = jitterRange(headerValue(headers, POTEMKIN_JITTER));
  const forceLatency = boundedNonNegative(
    headerValue(headers, POTEMKIN_FORCE_LATENCY),
    MAX_RUNTIME_DELAY_MS,
  );
  const slowResponse = boundedNonNegative(
    headerValue(headers, POTEMKIN_SLOW_RESPONSE),
    MAX_RUNTIME_DELAY_MS,
  );
  const combinedLatency =
    forceLatency === undefined && slowResponse === undefined
      ? undefined
      : Math.min(MAX_RUNTIME_DELAY_MS, (forceLatency ?? 0) + (slowResponse ?? 0));
  const dropConnection = boundedNonNegative(
    headerValue(headers, POTEMKIN_DROP_CONNECTION),
    MAX_RUNTIME_DELAY_MS,
  );
  const successRaw = boundedNonNegative(headerValue(headers, POTEMKIN_SUCCESS_RATE));
  const successRate =
    successRaw === undefined
      ? undefined
      : successRaw > 1 && successRaw <= 100
        ? successRaw / 100
        : successRaw <= 1
          ? successRaw
          : undefined;

  const controls: RuntimeControls = {
    ...flattenRuntimeControlDefaults(defaults),
    ...parsed.transparency,
    ...parsed.sideEffects,
    ...parsed.timeTravel,
    ...parsed.format,
    ...parsed.validation,
    ...(parsed.identity.causedBy === undefined ? {} : { causedBy: parsed.identity.causedBy }),
    ...(parsed.observability.traceId === undefined
      ? {}
      : { traceId: parsed.observability.traceId }),
    ...(parsed.observability.spanName === undefined
      ? {}
      : { spanName: parsed.observability.spanName }),
    ...(parsed.observability.logLevel === undefined
      ? {}
      : { logLevel: parsed.observability.logLevel }),
    ...(parsed.observability.metricTag === undefined
      ? {}
      : { metricTag: parsed.observability.metricTag }),
    ...(headerValue(headers, POTEMKIN_USE_FAULT) === undefined
      ? {}
      : { useFault: headerValue(headers, POTEMKIN_USE_FAULT) }),
    ...(headerValue(headers, POTEMKIN_FEATURE_FLAG) === undefined
      ? {}
      : { featureFlag: headerValue(headers, POTEMKIN_FEATURE_FLAG) }),
    ...(rateLimit === undefined
      ? {}
      : { rateLimit: !['false', '0', 'off', 'no'].includes(rateLimit) }),
    ...(signal === undefined ? {} : { signal }),
    ...(headerValue(headers, POTEMKIN_FORCE_RESPONSE) === undefined
      ? {}
      : { forceResponse: headerValue(headers, POTEMKIN_FORCE_RESPONSE) }),
    ...(headerValue(headers, POTEMKIN_SCENARIO) === undefined
      ? {}
      : { scenario: headerValue(headers, POTEMKIN_SCENARIO) }),
    ...(forceStatus === undefined ? {} : { forceStatus: Math.floor(forceStatus) }),
    ...(errorClass !== undefined &&
    ['timeout', 'throttle', 'outage', 'bad_gateway', 'conflict', 'auth', 'forbidden'].includes(
      errorClass,
    )
      ? { errorClass: errorClass as RuntimeControls['errorClass'] }
      : {}),
    ...(combinedLatency === undefined ? {} : { forceLatencyMs: combinedLatency }),
    ...(jitter === undefined ? {} : { jitterMs: jitter }),
    ...(dropConnection === undefined ? {} : { dropConnectionMs: dropConnection }),
    ...(successRate === undefined ? {} : { successRate }),
    ...(boundedNonNegative(headerValue(headers, POTEMKIN_RETRY_AFTER)) === undefined
      ? {}
      : {
          retryAfterSeconds: boundedNonNegative(headerValue(headers, POTEMKIN_RETRY_AFTER)),
        }),
    ...(boundedNonNegative(headerValue(headers, POTEMKIN_BODY_TRUNCATE)) === undefined
      ? {}
      : {
          bodyTruncateBytes: Math.floor(
            boundedNonNegative(headerValue(headers, POTEMKIN_BODY_TRUNCATE))!,
          ),
        }),
  };
  return normalizeRuntimeControls(controls) ?? {};
}

export function controlsOf(request: Request, defaults?: RuntimeControlDefaults): RuntimeControls {
  return controlsFromHeaders(request.headers as RuntimeHeaderValues, defaults);
}
