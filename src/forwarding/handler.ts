/**
 * Express handler for the /_engine/forward and /_engine/health endpoints.
 *
 * POST /_engine/forward
 *   Accepts a ForwardedRequest in the JSON body, runs it through the same
 *   CQRS/ES pipeline that the regular HTTP gateway uses, and returns a ForwardedResponse.
 *
 * GET /_engine/health
 *   Returns a lightweight health-check payload.
 */

import type { RequestHandler, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import type { BootedSystem } from '../engine/boot.js';
import type { JournalEntry } from '../dsl/patches.js';
import type { BoundaryConfig } from '../dsl/types.js';
import type { OpenApiOperation } from '../contract/loader.js';
import type { ControlHeaders } from '../http/controlHeaders.js';
import type { Logger } from '../observability/logger.js';
import type { CelEvaluator } from '../cel/evaluator.js';
import type { ForwardedRequest, ForwardedResponse, RoutesDiscoveryResponse, FixturesResponse, FixtureStub } from './types.js';
import { deriveFixtures } from './fixtures.js';
import type { Actor, Command, Intent, JsonObject, JsonValue } from '../types.js';
import { matchRoute } from '../contract/router.js';
import { translateIntent } from '../engine/router.js';
import { executeUnitOfWork } from '../engine/uow.js';
import { createSideEffectQueue } from '../engine/sideEffects.js';
import { extractFaultSignal } from '../engine/faultSim.js';
import { nextUuidv7 } from '../ids/uuidv7.js';
import { resolveActor, JwtValidationError } from '../identity/actorResolver.js';
import { applyResponseMutations, buildOperationLookup } from '../http/responseMutations.js';
import { parseControlHeaders, applyMask } from '../http/controlHeaders.js';
import { applyPaginationStyle, applyResponseFormat } from '../http/responseFormat.js';
import { resolveChaosHeaders, truncateBody } from '../http/chaosHeaders.js';
import { evaluateFaultRules } from '../faults/index.js';
import { rebuildEntityAtVersion, findEventById } from '../engine/timeTravel.js';
import {
  corsPreflightHeaders,
  resolveBoundaryLatencyMs,
  delay,
  shouldReturnNotModified,
  lastModifiedFromBody,
  isSingleEntityBody,
  applyHateoasToQueryBody,
  applyDebugEnvelope,
  lowercaseHeaders,
  splitBoundaryFaults,
} from './responsePipeline.js';
import {
  EntityAbsenceError,
  EntityConflictError,
  UnhandledOperationError,
  ConcurrencyConflictError,
  MissingPreconditionError,
  InfiniteLoopError,
  ContractViolationError,
  InternalExecutionError,
  FaultSimulatedError,
  AuthenticationRequiredError,
  AuthorizationDeniedError,
  IdempotencyConflictError,
} from '../errors.js';

// Dynamic require is the most portable cross-compile approach for JSON imports.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PKG_VERSION: string = (require('../../package.json') as { version: string }).version;

/**
 * Case-insensitively read a header from a forwarded headers map.
 *
 * The forwarding contract documents lowercase keys, but callers may forward
 * original casing (e.g. `If-Match`, `Authorization`). We try the lowercase key
 * first and fall back to a case-insensitive scan only when that misses.
 */
export function readForwardedHeader(
  headers: Record<string, string>,
  lowercaseName: string,
): string | undefined {
  const direct = headers[lowercaseName];
  if (direct !== undefined) return direct;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowercaseName) return headers[key];
  }
  return undefined;
}

/**
 * Return true if the value looks like a valid ForwardedRequest.
 * We only check the structural contract — not the full type — to keep this simple.
 */
function isForwardedRequest(val: unknown): val is ForwardedRequest {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) return false;
  const obj = val as Record<string, unknown>;
  if (typeof obj['method'] !== 'string') return false;
  if (typeof obj['path'] !== 'string') return false;
  if (obj['headers'] === null || typeof obj['headers'] !== 'object' || Array.isArray(obj['headers'])) return false;
  if (obj['query'] === null || typeof obj['query'] !== 'object' || Array.isArray(obj['query'])) return false;
  // body may be any JsonValue (including null)
  if (!('body' in obj)) return false;
  return true;
}

type ErrorMapped = { status: number; body: JsonValue; headers?: Record<string, string> };

function mapErrorToStatus(err: unknown): ErrorMapped {
  // toJSON() returns Record<string,unknown>; we cast to JsonValue (structurally compatible).
  const asJson = (e: { toJSON(): Record<string, unknown> }): JsonValue =>
    e.toJSON() as JsonValue;

  if (err instanceof AuthenticationRequiredError) {
    return { status: 401, body: asJson(err) };
  }
  if (err instanceof AuthorizationDeniedError) {
    return { status: 403, body: asJson(err) };
  }
  if (err instanceof EntityAbsenceError) {
    return { status: 404, body: asJson(err) };
  }
  if (err instanceof EntityConflictError) {
    return { status: 409, body: asJson(err) };
  }
  if (err instanceof UnhandledOperationError) {
    return { status: 422, body: asJson(err) };
  }
  if (err instanceof ConcurrencyConflictError) {
    return { status: 412, body: asJson(err) };
  }
  if (err instanceof MissingPreconditionError) {
    return { status: 428, body: asJson(err) };
  }
  if (err instanceof InfiniteLoopError) {
    return { status: 508, body: asJson(err) };
  }
  if (err instanceof ContractViolationError) {
    return { status: 400, body: asJson(err) };
  }
  if (err instanceof InternalExecutionError) {
    return { status: 500, body: asJson(err) };
  }
  if (err instanceof FaultSimulatedError) {
    return {
      status: err.status,
      body: asJson(err),
      headers: err.simulatedHeaders ?? undefined,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, body: { error: 'INTERNAL', message } };
}

/**
 * Create an Express request handler that implements the forwarding endpoint.
 * The handler reads a ForwardedRequest from req.body and returns a ForwardedResponse.
 */
export function createForwardingHandler(sys: BootedSystem): RequestHandler {
  return async function forwardingHandler(req: Request, res: Response): Promise<void> {
    if (!isForwardedRequest(req.body)) {
      res.status(400).json({
        error: 'MALFORMED_FORWARDED_REQUEST',
        message: 'Request body must be a ForwardedRequest object with method, path, headers, query, and body fields.',
      });
      return;
    }

    const fwd: ForwardedRequest = req.body as ForwardedRequest;

    // Always HTTP 200 on the wire; the real status travels in the envelope's `status` field.
    const send = (r: ForwardedResponse): void => { res.status(200).json(r); };

    const rawMethod = fwd.method.toUpperCase();
    const path = fwd.path;

    // HEAD is processed as GET (RFC 7231 §4.3.2); body is emptied on the way out.
    // OPTIONS is answered as a CORS preflight before any routing.
    const isHead = rawMethod === 'HEAD';
    const method = isHead ? 'GET' : rawMethod;

    if (rawMethod === 'OPTIONS') {
      const preflightOrigin = readForwardedHeader(fwd.headers, 'origin');
      const preflightCredentialed = Boolean(
        readForwardedHeader(fwd.headers, 'authorization') ??
        readForwardedHeader(fwd.headers, 'cookie'),
      );
      send({ status: 204, headers: corsPreflightHeaders(preflightOrigin, preflightCredentialed), body: null });
      return;
    }

    // Normalise to lowercase once; original casing must never mis-route.
    const lc = lowercaseHeaders(fwd.headers);

    // Fault-sim: honour x-specmatic-fault.
    try {
      const fault = extractFaultSignal(fwd.headers as Record<string, string | string[] | undefined>);
      if (fault !== null) {
        sys.metrics.faultsSimulatedTotal.add(1);
        send({ status: fault.status, headers: fault.headers ?? {}, body: isHead ? null : fault.body });
        return;
      }
    } catch (err) {
      const mapped = mapErrorToStatus(err);
      send({ status: mapped.status, headers: mapped.headers ?? {}, body: mapped.body });
      return;
    }

    const route = matchRoute(sys.openapi, method, path);
    if (route === null) {
      send({ status: 404, headers: {}, body: { error: 'NO_ROUTE', path } });
      return;
    }

    const boundary = sys.dsl.byContractPath[route.contractPath];
    if (boundary === undefined) {
      send({ status: 404, headers: {}, body: { error: 'NO_BOUNDARY', contractPath: route.contractPath } });
      return;
    }

    const controls = parseControlHeaders(lc);

    // Per-request CEL sub-evaluator: layers clock offset + faker seed on top of
    // the shared evaluator WITHOUT mutating it, so concurrent requests each
    // observe their own offset/seed with no cross-request leak.
    const reqCel = sys.cel.withRequestContext({
      ...(controls.transparency.clockOffsetMs !== undefined ? { clockOffsetMs: controls.transparency.clockOffsetMs } : {}),
      ...(controls.transparency.seed !== undefined ? { seed: controls.transparency.seed } : {}),
    });

    // 5a. Admin gating for actor-override / impersonate and request-validation skip.
    const usesAdminGated =
      Boolean(controls.identity.actorOverride) ||
      Boolean(controls.identity.impersonate) ||
      controls.validation.skipRequestValidation === true;
    if (usesAdminGated) {
      let callerActor;
      try {
        callerActor = resolveActor(readForwardedHeader(fwd.headers, 'authorization'), sys.dsl.auth);
      } catch (e) {
        if (e instanceof JwtValidationError) {
          send({ status: 401, headers: { 'www-authenticate': 'Bearer' }, body: { error: 'UNAUTHENTICATED', message: e.message, details: { code: e.code } } });
          return;
        }
        throw e;
      }
      const isAdmin = (callerActor?.scopes ?? []).includes('admin');
      if (!isAdmin) {
        send({ status: 401, headers: {}, body: { error: 'ADMIN_REQUIRED', message: 'admin scope required for this X-Potemkin-* header' } });
        return;
      }
    }

    let intent: Intent;
    try {
      intent = translateIntent({ method, boundary });
    } catch (err) {
      const mapped = mapErrorToStatus(err);
      send({ status: mapped.status, headers: mapped.headers ?? {}, body: mapped.body });
      return;
    }

    const logger = sys.logger.child({ forwardedPath: path, forwardedMethod: rawMethod });

    // Forwarding path is Bearer/JWT only (no session cookie).
    let actor: Actor | undefined;
    try {
      actor = resolveActor(readForwardedHeader(fwd.headers, 'authorization'), sys.dsl.auth) ?? undefined;
    } catch (e) {
      if (e instanceof JwtValidationError) {
        send({ status: 401, headers: { 'www-authenticate': 'Bearer' }, body: { error: 'UNAUTHENTICATED', message: e.message, details: { code: e.code } } });
        return;
      }
      throw e;
    }
    // Tier 3: actor override / impersonate (admin-gated above).
    const adminOverride = controls.identity.actorOverride ?? controls.identity.impersonate;
    if (adminOverride) {
      const [id, scopesStr] = adminOverride.split(':', 2);
      actor = { id: id ?? 'unknown', scopes: (scopesStr ?? '').split(',').filter(Boolean) };
    }

    // Tier 4: time-travel intercepts for GET requests — projects transient state
    // from the event log; never runs the UoW.
    if (method === 'GET') {
      const ttTargetId = route.pathParams['id'] ?? null;
      if (controls.timeTravel.readAtVersion !== undefined && ttTargetId !== null) {
        const ttInferred = sys.inferredSchemas?.[boundary.boundary];
        const ttComputedArgs = ttInferred && ttInferred.computedOrder.length > 0
          ? { computed: sys.dsl.byBoundaryName[boundary.boundary]?.state?.computed ?? [], computedOrder: ttInferred.computedOrder }
          : {};
        const rebuilt = rebuildEntityAtVersion(
          ttTargetId, controls.timeTravel.readAtVersion, boundary, sys.events, reqCel, logger,
          sys.tsReducerRegistry,
          ttComputedArgs.computed,
          ttComputedArgs.computedOrder,
        );
        const headers = { 'x-potemkin-read-at-version': String(controls.timeTravel.readAtVersion) };
        if (rebuilt === null) {
          send({ status: 404, headers, body: { error: 'ENTITY_ABSENCE', message: `entity ${ttTargetId} not found at version ${controls.timeTravel.readAtVersion}` } });
        } else {
          send({ status: 200, headers, body: isHead ? null : rebuilt });
        }
        return;
      }
      if (controls.timeTravel.replayEvent) {
        const evt = findEventById(controls.timeTravel.replayEvent, sys.events);
        const headers = { 'x-potemkin-replayed-event': controls.timeTravel.replayEvent };
        if (!evt) {
          send({ status: 404, headers, body: { error: 'EVENT_NOT_FOUND', message: `event ${controls.timeTravel.replayEvent} not found` } });
        } else {
          send({
            status: 200,
            headers,
            body: isHead ? null : {
              eventId: evt.eventId,
              type: evt.type,
              aggregateId: evt.aggregateId,
              sequenceVersion: evt.sequenceVersion,
              timestamp: evt.timestamp,
              payload: evt.payload,
              causedBy: evt.causedBy ?? null,
            },
          });
        }
        return;
      }
    }

    // 8b. Chaos headers — resolve X-Potemkin-* chaos primitives.
    const faultRules = sys.dsl.faults ?? [];
    const chaos = resolveChaosHeaders(lc, faultRules);

    const isBulkArrayBody =
      controls.sideEffects.bulkTransactional === true && Array.isArray(fwd.body);
    const isCreationArrayBody = intent === 'creation' && Array.isArray(fwd.body);
    if (
      controls.validation.skipRequestValidation !== true &&
      !isBulkArrayBody && !isCreationArrayBody &&
      chaos.response === undefined
    ) {
      try {
        sys.validator.validateRequest(
          method,
          route.contractPath,
          (fwd.body as JsonValue | null | undefined) ?? {},
          fwd.query,
          route.pathParams,
        );
      } catch (err) {
        if (err instanceof ContractViolationError) {
          send({ status: 400, headers: { 'x-specmatic-result': 'failure' }, body: { error: 'CONTRACT_VIOLATION', details: err.details ?? err.message } });
          return;
        }
        throw err;
      }
    }

    if (Array.isArray(fwd.body) && (isBulkArrayBody || isCreationArrayBody)) {
      await runBulkCreate({ sys, fwd, route, boundary, intent, method, path, actor, controls, logger, send, reqCel });
      return;
    }

    // If-Match: strip quotes before parsing to integer. Weak validators (W/"5")
    // produce NaN — return a 400 rather than passing NaN into the UoW.
    const ifMatchValue = readForwardedHeader(fwd.headers, 'if-match');
    let sequenceVersion: number | undefined;
    if (ifMatchValue !== undefined) {
      const parsed = Number(String(ifMatchValue).replace(/^"|"$/g, ''));
      if (Number.isNaN(parsed)) {
        send({ status: 400, headers: {}, body: { error: 'INVALID_IF_MATCH', message: 'If-Match value is not a valid integer (weak validators are not supported)' } });
        return;
      }
      sequenceVersion = parsed;
    }
    const faultHeaderRaw = readForwardedHeader(fwd.headers, 'x-specmatic-fault');

    let targetId: string | null = route.pathParams['id'] ?? null;
    if (intent === 'creation' && targetId === null) {
      const genRule = boundary.identity?.creation?.generate;
      if (genRule === '$uuidv7()') targetId = nextUuidv7();
    }

    const command: Command = {
      commandId: nextUuidv7(),
      boundary: boundary.boundary,
      intent,
      targetId,
      payload: (fwd.body as JsonObject | null | undefined) ?? {},
      queryParams: fwd.query,
      httpMethod: method,
      path,
      sequenceVersion,
      origin: 'inbound',
      depth: 0,
      headers: lc,
      ...(faultHeaderRaw ? { faultSignal: faultHeaderRaw } : {}),
      ...(actor !== undefined ? { actor } : {}),
    };

    // DSL fault rules — evaluate before the UoW so a match mutates no state.
    // Skipped when Skip-Dispatch is set.
    const dynamicFaults = sys.faultStore.all();
    if (
      chaos.response === undefined &&
      (faultRules.length > 0 || (boundary.faults?.length ?? 0) > 0 || dynamicFaults.length > 0) &&
      controls.sideEffects.skipDispatch !== true
    ) {
      const split = splitBoundaryFaults(faultRules, boundary.boundary);
      const faultResponse = evaluateFaultRules({
        command,
        boundaryFaults: [...split.boundary, ...(boundary.faults ?? [])],
        globalFaults: split.global,
        dynamicFaults,
        cel: reqCel,
        state: command.targetId !== null ? (sys.graph.get(command.targetId) as JsonObject | null) : null,
        logger,
      });
      if (faultResponse !== null) {
        sys.metrics.faultsSimulatedTotal.add(1);
        // Apply the rule's pre-response delay on top of any boundary latency.
        await delay(resolveBoundaryLatencyMs(boundary.latency) + (faultResponse.delay_ms ?? 0));
        const headers = lowercaseHeaderMap(faultResponse.headers);
        send({ status: faultResponse.status, headers, body: isHead ? null : (faultResponse.body ?? null) });
        return;
      }
    }

    const boundaryLatencyMs = resolveBoundaryLatencyMs(boundary.latency);
    if (chaos.response !== undefined || chaos.dropConnection === true) {
      await delay(chaos.extraLatencyMs + boundaryLatencyMs);
      if (chaos.dropConnection === true) {
        // The forwarding layer cannot destroy the upstream socket, so it surfaces
        // a synthetic 504 + marker for the Kotlin plugin to treat as a dropped connection.
        send({ status: 504, headers: { 'x-potemkin-dropped': 'true' }, body: null });
        return;
      }
      const cr = chaos.response!;
      let body: JsonValue | null | undefined = cr.body ?? null;
      if (chaos.bodyTruncateBytes !== undefined && body !== null && body !== undefined) {
        body = truncateBody(body, chaos.bodyTruncateBytes);
      }
      send({ status: cr.status, headers: lowercaseHeaderMap(cr.headers), body: isHead ? null : body });
      return;
    }

    const idempotencyKey = readForwardedHeader(fwd.headers, 'idempotency-key');
    const idempotencyCfg = sys.dsl.idempotency;
    const idempotencyEnabled = idempotencyCfg?.enabled ?? false;

    if (idempotencyEnabled && idempotencyKey && intent !== 'query') {
      const store = sys.idempotencyStore;
      const requestBody: JsonValue = fwd.body ?? {};
      const hashIncludesBody = idempotencyCfg?.hashIncludesBody ?? true;
      try {
        const checkResult = store.check({ method, path, idempotencyKey, body: requestBody, hashIncludesBody });
        if (checkResult.hit) {
          const cached = checkResult.response;
          send({ status: cached.status, headers: { ...(cached.headers ?? {}), 'x-idempotency-replay': 'true' }, body: isHead ? null : (cached.body ?? null) });
          return;
        }
      } catch (err) {
        if (err instanceof IdempotencyConflictError) {
          send({ status: 409, headers: {}, body: err.toJSON() as JsonValue });
          return;
        }
        throw err;
      }
    }

    await delay(boundaryLatencyMs + chaos.extraLatencyMs);

    const deferred = controls.sideEffects.bulkTransactional === true
      ? createSideEffectQueue()
      : undefined;

    let result;
    try {
      result = await Promise.resolve(
        executeUnitOfWork({
          command,
          dsl: sys.dsl,
          graph: sys.graph,
          events: sys.events,
          cel: reqCel,
          validator: sys.validator,
          schemaRegistry: sys.schemaRegistry,
          aggregateLocks: sys.aggregateLocks,
          openapi: sys.openapi,
          requiresPrecondition: sys.requiresPrecondition,
          logger,
          tracer: sys.tracer,
          metrics: sys.metrics,
          derivedProjections: sys.derivedProjections,
          tsReducerRegistry: sys.tsReducerRegistry,
          inferredSchemas: sys.inferredSchemas,
          webhookTransport: sys.webhookTransport,
          controls,
          ...(deferred ? { deferSideEffects: deferred } : {}),
          ...(controls.sideEffects.maxCascadeDepth !== undefined
            ? { maxDepth: controls.sideEffects.maxCascadeDepth + 1 }
            : {}),
        }),
      );
      deferred?.flush(logger);
    } catch (err) {
      deferred?.discard();
      logger.error({ err }, 'UoW execution error in forwarding handler');
      const mapped = mapErrorToStatus(err);
      send({ status: mapped.status, headers: { ...(mapped.headers ?? {}), 'x-specmatic-result': 'failure' }, body: mapped.body });
      return;
    }

    const responseHeaders: Record<string, string> = { ...(result.headers ?? {}) };

    const isMutating = intent === 'mutation' || intent === 'creation';
    if (isMutating && result.events.length > 0) {
      const primaryAggregateId = command.targetId;
      const primaryEvents = primaryAggregateId !== null
        ? result.events.filter(e => e.aggregateId === primaryAggregateId)
        : result.events;
      const seqForEtag = primaryEvents.length > 0
        ? primaryEvents.at(-1)?.sequenceVersion
        : result.events.at(-1)?.sequenceVersion;
      if (seqForEtag !== undefined) responseHeaders['etag'] = '"' + String(seqForEtag) + '"';
    }

    // Single-entity GET (RFC 7232): emit ETag + Last-Modified.
    const isSingleEntityGet =
      intent === 'query' && command.targetId !== null &&
      result.status >= 200 && result.status < 300 &&
      isSingleEntityBody(result.body);
    let lastModified: string | undefined;
    if (isSingleEntityGet && command.targetId !== null) {
      const seq = sys.events.currentSequenceVersion(command.targetId);
      if (seq > 0) responseHeaders['etag'] = '"' + String(seq) + '"';
      lastModified = lastModifiedFromBody(result.body);
      if (lastModified !== undefined) responseHeaders['last-modified'] = lastModified;
    }

    if (isSingleEntityGet) {
      const notModified = shouldReturnNotModified({
        ...(responseHeaders['etag'] !== undefined ? { etag: responseHeaders['etag'] } : {}),
        ...(lastModified !== undefined ? { lastModified } : {}),
        ...(readForwardedHeader(fwd.headers, 'if-none-match') !== undefined
          ? { ifNoneMatch: readForwardedHeader(fwd.headers, 'if-none-match') } : {}),
        ...(readForwardedHeader(fwd.headers, 'if-modified-since') !== undefined
          ? { ifModifiedSince: readForwardedHeader(fwd.headers, 'if-modified-since') } : {}),
      });
      if (notModified) {
        const condHeaders: Record<string, string> = {};
        if (responseHeaders['etag'] !== undefined) condHeaders['etag'] = responseHeaders['etag'];
        if (responseHeaders['last-modified'] !== undefined) condHeaders['last-modified'] = responseHeaders['last-modified'];
        send({ status: 304, headers: condHeaders, body: null });
        return;
      }
    }

    let outBody: JsonValue | null | undefined = result.body;

    // Response mutations — HATEOAS/_links, mask, deprecation headers.
    // Body patches are reported in `_patches` for the plugin's response interceptor.
    let patches: readonly JournalEntry[] | undefined;
    if (result.status >= 200 && result.status < 300 && outBody !== null && outBody !== undefined) {
      const pathItem = sys.openapi.paths[route.contractPath] as
        | Record<string, OpenApiOperation | undefined>
        | undefined;
      const mutation = applyResponseMutations({
        body: outBody,
        boundary,
        operation: pathItem ? pathItem[method.toLowerCase()] : undefined,
        statusCode: result.status,
        operationLookup: buildOperationLookup(sys.openapi),
      });
      for (const [k, v] of Object.entries(mutation.headers)) responseHeaders[k.toLowerCase()] = v;
      const bodyPatches = mutation.journal.filter((e) => e.source === 'hateoas' || e.source === 'mask');
      if (bodyPatches.length > 0) patches = bodyPatches;
    }

    // HATEOAS — applied to the live body so plugin-less callers also see the links.
    if (intent === 'query' && result.status >= 200 && result.status < 300) {
      outBody = applyHateoasToQueryBody(outBody, boundary, sys.dsl, reqCel, fwd.query);
    }

    if (controls.format.maskFields && controls.format.maskFields.length > 0) {
      outBody = applyMask(outBody, controls.format.maskFields) as JsonValue | null | undefined;
    }

    // Tier 5: pagination style then response format.
    if (
      controls.format.paginationStyle !== undefined &&
      result.status >= 200 && result.status < 300 &&
      outBody !== null && outBody !== undefined
    ) {
      const paged = applyPaginationStyle(outBody, controls.format.paginationStyle, fwd.query, path);
      outBody = paged.body;
      for (const [k, v] of Object.entries(paged.headers)) responseHeaders[k.toLowerCase()] = v;
    }
    if (
      controls.format.responseFormat !== undefined &&
      result.status >= 200 && result.status < 300 &&
      outBody !== null && outBody !== undefined
    ) {
      outBody = applyResponseFormat(outBody, controls.format.responseFormat, boundary.boundary, path);
      responseHeaders['x-potemkin-response-format'] = controls.format.responseFormat;
    }

    // Tier 1: include-events / echo debug envelope.
    outBody = applyDebugEnvelope({
      body: outBody,
      includeEvents: controls.transparency.includeEvents === true,
      echo: controls.transparency.echo === true,
      events: (result.events ?? []).map(e => ({
        eventId: e.eventId, type: e.type, aggregateId: e.aggregateId,
        sequenceVersion: e.sequenceVersion, timestamp: e.timestamp,
        payload: e.payload as JsonValue, causedBy: e.causedBy,
      })),
      boundary: boundary.boundary,
      intent,
      targetId: command.targetId,
      dryRun: controls.transparency.dryRun === true,
      method,
      path,
    });

    if (controls.transparency.dryRun === true) responseHeaders['x-potemkin-dry-run'] = 'true';

    // Tier 6: echo trace id / span name back for correlation.
    if (controls.observability.traceId) responseHeaders['x-potemkin-trace-id'] = controls.observability.traceId;
    if (controls.observability.spanName) responseHeaders['x-potemkin-span-name'] = controls.observability.spanName;

    // X-Specmatic-Result: success on 2xx, failure otherwise.
    responseHeaders['x-specmatic-result'] = result.status >= 200 && result.status < 300 ? 'success' : 'failure';

    // X-Potemkin-Body-Truncate — slice the serialised body to N bytes if set.
    if (chaos.bodyTruncateBytes !== undefined && outBody !== null && outBody !== undefined) {
      outBody = truncateBody(outBody, chaos.bodyTruncateBytes);
    }

    // Record idempotency entry after the full pipeline so the cached response
    // matches exactly what the caller received (HATEOAS, mask, format, trace headers applied).
    if (idempotencyEnabled && idempotencyKey && intent !== 'query') {
      const store = sys.idempotencyStore;
      const requestBody: JsonValue = fwd.body ?? {};
      const hashIncludesBody = idempotencyCfg?.hashIncludesBody ?? true;
      const ttlMs = (idempotencyCfg?.ttlSeconds ?? 86400) * 1000;
      try {
        store.record({
          method, path, idempotencyKey, body: requestBody, hashIncludesBody,
          response: { status: result.status, body: outBody ?? null, headers: responseHeaders },
          ttlMs,
        });
      } catch {
        logger.warn({ idempotencyKey }, 'Failed to record idempotency entry in forwarding handler');
      }
    }

    send({
      status: result.status,
      headers: responseHeaders,
      // HEAD responses carry no body (RFC 7231 §4.3.2).
      body: isHead ? null : (outBody ?? null),
      ...(patches !== undefined && !isHead ? { _patches: patches } : {}),
    });
  };
}

/** Lowercase the keys of an optional header map (chaos/fault responses use mixed casing). */
function lowercaseHeaderMap(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

/**
 * Execute a bulk-create: loop each item in an array body through its own Unit of
 * Work (validating per-item) and return the collected result bodies as an array.
 * Mirrors the gateway bulk pattern. Side-effects defer into one batch-scoped queue
 * flushed once on full success.
 */
async function runBulkCreate(args: {
  sys: BootedSystem;
  fwd: ForwardedRequest;
  route: { contractPath: string; pathParams: Record<string, string> };
  boundary: BoundaryConfig;
  intent: Intent;
  method: string;
  path: string;
  actor: Actor | undefined;
  controls: ControlHeaders;
  logger: Logger;
  send: (r: ForwardedResponse) => void;
  reqCel: CelEvaluator;
}): Promise<void> {
  const { sys, fwd, route, boundary, intent, method, path, actor, controls, logger, send, reqCel } = args;
  const items = fwd.body as JsonValue[];

  const eventSnapshot = sys.events.snapshot();
  const graphSnapshot = sys.graph.snapshot();
  const deferred = createSideEffectQueue();

  const results: JsonValue[] = [];
  let abortIndex: number | null = null;
  let abortError: string | undefined;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const isObj = item !== null && typeof item === 'object' && !Array.isArray(item);
    if (!isObj) {
      abortIndex = i;
      abortError = 'item must be an object';
      break;
    }

    if (controls.validation.skipRequestValidation !== true) {
      try {
        sys.validator.validateRequest(method, route.contractPath, item as JsonValue, fwd.query, route.pathParams);
      } catch (err) {
        abortIndex = i;
        abortError = err instanceof ContractViolationError
          ? (typeof err.details === 'string' ? err.details : err.message)
          : (err instanceof Error ? err.message : 'item rejected');
        break;
      }
    }

    let itemTargetId: string | null = route.pathParams['id'] ?? null;
    if (intent === 'creation' && itemTargetId === null) {
      const genRule = boundary.identity?.creation?.generate;
      if (genRule === '$uuidv7()') itemTargetId = nextUuidv7();
    }

    const itemCommand: Command = {
      commandId: nextUuidv7(),
      boundary: boundary.boundary,
      intent,
      targetId: itemTargetId,
      payload: item as JsonObject,
      queryParams: fwd.query,
      httpMethod: method,
      path,
      origin: 'inbound',
      depth: 0,
      headers: lowercaseHeaders(fwd.headers),
      ...(actor !== undefined ? { actor } : {}),
    };

    try {
      const itemResult = await Promise.resolve(
        executeUnitOfWork({
          command: itemCommand,
          dsl: sys.dsl,
          graph: sys.graph,
          events: sys.events,
          cel: reqCel,
          validator: sys.validator,
          schemaRegistry: sys.schemaRegistry,
          aggregateLocks: sys.aggregateLocks,
          openapi: sys.openapi,
          requiresPrecondition: sys.requiresPrecondition,
          logger,
          tracer: sys.tracer,
          metrics: sys.metrics,
          derivedProjections: sys.derivedProjections,
          tsReducerRegistry: sys.tsReducerRegistry,
          inferredSchemas: sys.inferredSchemas,
          webhookTransport: sys.webhookTransport,
          deferSideEffects: deferred,
          controls,
        }),
      );
      results.push(itemResult.body ?? null);
    } catch (err) {
      abortIndex = i;
      abortError = err instanceof Error ? err.message : 'item rejected';
      break;
    }
  }

  // Both bulk-transactional and best-effort arrays abort on first failure.
  if (abortIndex !== null) {
    deferred.discard();
    sys.events.restore(eventSnapshot);
    sys.graph.restore(graphSnapshot);
    send({
      status: 400,
      headers: { 'x-specmatic-result': 'failure' },
      body: { error: 'BULK_TRANSACTION_ABORTED', message: `bulk transaction aborted at item ${abortIndex}: ${abortError ?? 'unknown'}`, abortIndex },
    });
    return;
  }

  deferred.flush(logger);
  // Route the created-array through mask → pagination → format so the same
  // X-Potemkin-* controls apply to bulk results as to single responses.
  let bulkBody: JsonValue = results;
  const bulkHeaders: Record<string, string> = { 'x-specmatic-result': 'success' };
  if (controls.format.maskFields && controls.format.maskFields.length > 0) {
    const fields = controls.format.maskFields;
    bulkBody = results.map((item) => applyMask(item, fields) as JsonValue);
  }
  if (controls.format.paginationStyle !== undefined) {
    const paged = applyPaginationStyle(bulkBody, controls.format.paginationStyle, fwd.query, path);
    bulkBody = paged.body;
    for (const [k, v] of Object.entries(paged.headers)) bulkHeaders[k.toLowerCase()] = v;
  }
  if (controls.format.responseFormat !== undefined) {
    bulkBody = applyResponseFormat(bulkBody, controls.format.responseFormat, boundary.boundary, path);
    bulkHeaders['x-potemkin-response-format'] = controls.format.responseFormat;
  }
  send({ status: 201, headers: bulkHeaders, body: bulkBody });
}

/**
 * Lightweight health-check endpoint handler for GET /_engine/health.
 */
export function healthHandler(_req: Request, res: Response): void {
  res.status(200).json({
    status: 'UP',
    engine: 'potemkin-stateful',
    version: PKG_VERSION,
  });
}

/** Default TTL in seconds for the routes discovery response. */
const DEFAULT_ROUTES_TTL = 30;

/**
 * Compute a stable SHA-256 hex checksum over an alphabetically-sorted list of
 * contract paths.  The paths are joined with newlines before hashing so that
 * an empty list and a single empty-string path produce different digests.
 */
function computePathsChecksum(sortedPaths: readonly string[]): string {
  return createHash('sha256').update(sortedPaths.join('\n')).digest('hex');
}

/**
 * Resolve the TTL in seconds from the ENGINE_ROUTES_TTL_SECONDS environment
 * variable, falling back to DEFAULT_ROUTES_TTL when the variable is absent or
 * not a positive integer.
 */
function resolveRoutesTtl(): number {
  const raw = process.env['ENGINE_ROUTES_TTL_SECONDS'];
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_ROUTES_TTL;
}

/**
 * Create an Express request handler that implements GET /_engine/routes.
 *
 * The handler returns a RoutesDiscoveryResponse containing the sorted list of
 * contract paths that the engine owns, a checksum for change-detection, and
 * caching hints.  It supports conditional requests via If-None-Match / ETag.
 */
export function createRoutesHandler(sys: BootedSystem): RequestHandler {
  return function routesHandler(req: Request, res: Response): void {
    const sortedPaths = Object.keys(sys.dsl.byContractPath).sort();
    const checksum = computePathsChecksum(sortedPaths);
    const ttlSeconds = resolveRoutesTtl();

    // Conditional request: respond 304 when the client's ETag matches.
    // Strip surrounding quotes to accept both the quoted ETag we emit and the
    // bare checksum (the Kotlin client echoes whatever it received).
    const ifNoneMatch = req.headers['if-none-match'];
    const stripQuotes = (s: string): string => s.trim().replace(/^"|"$/g, '');
    if (ifNoneMatch !== undefined && stripQuotes(ifNoneMatch) === checksum) {
      res.status(304).end();
      return;
    }

    const body: RoutesDiscoveryResponse = {
      paths: sortedPaths,
      engine: 'potemkin-stateful',
      version: PKG_VERSION,
      ttlSeconds,
      generatedAt: new Date().toISOString(),
      checksum,
    };

    res.setHeader('Cache-Control', `max-age=${ttlSeconds}, public`);
    res.setHeader('ETag', `"${checksum}"`);
    res.status(200).json(body);
  };
}

/**
 * Compute a SHA-256 hex checksum over the serialised FixtureStub list.
 * Stubs are sorted by their bound path before serialisation so the checksum
 * is deterministic regardless of insertion order.
 */
function computeFixturesChecksum(
  stubs: readonly FixtureStub[],
): string {
  const sorted = [...stubs].sort((a, b) =>
    a.httpRequest.path.localeCompare(b.httpRequest.path),
  );
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/**
 * Create an Express request handler that implements GET /_engine/fixtures.
 *
 * Derives a deterministic list of FixtureStubs from the booted system's baseline
 * events, serialises them, and returns a FixturesResponse.  Supports conditional
 * requests via If-None-Match / ETag (304 Not Modified when checksum matches).
 *
 * Cache-Control and ETag use the same TTL env var as GET /_engine/routes.
 */
export function createFixturesHandler(sys: BootedSystem): RequestHandler {
  // Lazily cached — derived once at first request and reused (boot-time snapshot).
  let cachedStubs: readonly FixtureStub[] | null = null;
  let cachedChecksum: string | null = null;

  return function fixturesHandler(req: Request, res: Response): void {
    // Derive fixtures on first call and cache.
    if (cachedStubs === null) {
      cachedStubs = deriveFixtures(sys);
      cachedChecksum = computeFixturesChecksum(cachedStubs);
    }

    const checksum = cachedChecksum!;
    const ttlSeconds = resolveRoutesTtl();

    // Conditional request: respond 304 when the client's ETag matches.
    const ifNoneMatch = req.headers['if-none-match'];
    const stripQuotes = (s: string): string => s.trim().replace(/^"|"$/g, '');
    if (ifNoneMatch !== undefined && stripQuotes(ifNoneMatch) === checksum) {
      res.status(304).end();
      return;
    }

    const body: FixturesResponse = {
      engine: 'potemkin-stateful',
      version: PKG_VERSION,
      generatedAt: new Date().toISOString(),
      checksum,
      fixtures: cachedStubs,
    };

    res.setHeader('Cache-Control', `max-age=${ttlSeconds}, public`);
    res.setHeader('ETag', `"${checksum}"`);
    res.status(200).json(body);
  };
}
