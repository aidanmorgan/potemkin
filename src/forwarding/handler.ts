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
import { extractEntityKey } from '../engine/keyExtractor.js';
import { resolveCreationTargetId } from '../engine/patternMatcher.js';
import { executeUnitOfWork } from '../engine/uow.js';
import { createSideEffectQueue } from '../engine/sideEffects.js';
import { extractFaultSignal } from '../engine/faultSim.js';
import { nextUuidv7 } from '../ids/uuidv7.js';
import { resolveActor, JwtValidationError } from '../identity/actorResolver.js';
import { applyResponseMutations, buildOperationLookup } from '../http/responseMutations.js';
import { parseControlHeaders, applyMask } from '../http/controlHeaders.js';
import { applyPaginationStyle, applyResponseFormat } from '../http/responseFormat.js';
import { resolveChaosHeaders, truncateBody } from '../http/chaosHeaders.js';
import { buildSecurityHeaders } from '../http/securityHeaders.js';
import { evaluateFaultRules } from '../faults/index.js';
import { rebuildEntityAtVersion, findEventById } from '../engine/timeTravel.js';
import { checkScopes } from '../identity/scopeChecker.js';
import { lookupOperationId } from '../contract/loader.js';
import type { CachedResponse } from '../idempotency/store.js';
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
 *
 * API versioning (URL-prefix stripping + X-Potemkin-Version) is a gateway-mode
 * HTTP middleware concern registered in src/http/gateway.ts. It is intentionally
 * NOT applied here: the /_engine/forward body carries an already-resolved request
 * path (the Kotlin plugin issues the real HTTP call, Specmatic handles contract
 * routing, and the resolved path arrives here prefix-free). Version routing in
 * the full Specmatic stack is a contract/stub concern, not a forwarding-body one.
 * See the transport note in tests/e2e/47-api-versioning.e2e-test.ts.
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
    // Security headers (viyn): build once per request, lowercase the keys to match the
    // ForwardedResponse lowercase-header convention, then merge into every outgoing envelope
    // as defaults — explicit per-response headers win (same precedence as the gateway
    // middleware, which uses setHeader so per-handler assignments override it).
    const rawSecHeaders = buildSecurityHeaders(sys.dsl.securityHeaders);
    const dslSecurityHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawSecHeaders)) dslSecurityHeaders[k.toLowerCase()] = v;
    const send = (r: ForwardedResponse): void => {
      const merged: ForwardedResponse = Object.keys(dslSecurityHeaders).length > 0
        ? { ...r, headers: { ...dslSecurityHeaders, ...(r.headers ?? {}) } }
        : r;
      res.status(200).json(merged);
    };

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

    // 5a. Admin gating for actor-override / impersonate and request/response-validation skips.
    const usesAdminGated =
      Boolean(controls.identity.actorOverride) ||
      Boolean(controls.identity.impersonate) ||
      controls.validation.skipRequestValidation === true ||
      controls.validation.skipResponseValidation === true ||
      controls.validation.allowAdditionalProperties === true;
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
        // RFC 7235: 401 = not authenticated; 403 = authenticated but forbidden.
        const status = callerActor === null ? 401 : 403;
        send({ status, headers: {}, body: { error: 'ADMIN_REQUIRED', message: 'admin scope required for this X-Potemkin-* header' } });
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
    // Tier 3: actor override / impersonate (admin-gated above). Parse with
    // indexOf/slice (split on the FIRST colon only) so resource:action scopes
    // (e.g. vault:write) survive intact — mirrors src/identity/actorExtractor.ts.
    const adminOverride = controls.identity.actorOverride ?? controls.identity.impersonate;
    if (adminOverride) {
      actor = parseActorOverride(adminOverride);
    }

    // 8b. Chaos headers — resolve X-Potemkin-* chaos primitives.
    // mh29: include boundary.faults so header-driven chaos (X-Potemkin-Use-Fault /
    // X-Potemkin-Force-Status) matching a boundary-scoped fault rule resolves the
    // same YAML-shaped response on the forwarding path as on the gateway path.
    // Mirror gateway.ts:714: const faultRules = [...globalFaults, ...boundaryFaults].
    const faultRules = [...(sys.dsl.faults ?? []), ...(boundary.faults ?? [])];
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

    // Resolve targetId: when the boundary declares identity.key, delegate to
    // extractEntityKey (reads from header/payload/query/path); otherwise it uses
    // the conventional {id} path parameter (REST /resource/{id} default).
    let targetId: string | null = extractEntityKey({
      boundary,
      pathParams: route.pathParams,
      queryParams: fwd.query,
      headers: lc,
      body: fwd.body as unknown,
    });
    if (intent === 'creation' && targetId === null) {
      const genRule = boundary.identity?.creation?.generate;
      if (genRule) {
        targetId = resolveCreationTargetId({
          generate: genRule,
          payload: (fwd.body ?? {}) as JsonObject,
          boundary: boundary.boundary,
          cel: reqCel,
          scriptRegistry: sys.dsl.scriptRegistry,
          now: () => new Date().toISOString(),
          logger: sys.logger,
        });
      }
    }

    // Tier 4: time-travel intercepts for GET requests — projects transient state
    // from the event log; never runs the UoW.
    // 5m9o: placed AFTER extractEntityKey so that boundaries with non-path
    // identity.key (from: query, header, payload) resolve a correct targetId here,
    // mirroring gateway.ts:559-574 which resolves targetId before the time-travel
    // block at line 575.
    if (method === 'GET') {
      // RBAC gate: enforce the matched GET operation's required_scopes BEFORE the
      // time-travel branch so an unscoped actor cannot read a protected entity by
      // appending a time-travel header.
      try {
        enforceGetReadScopes(sys, boundary, route.contractPath, actor);
      } catch (err) {
        const mapped = mapErrorToStatus(err);
        send({ status: mapped.status, headers: { ...(mapped.headers ?? {}), 'x-specmatic-result': 'failure' }, body: mapped.body });
        return;
      }
      if (controls.timeTravel.readAtVersion !== undefined && targetId !== null) {
        const ttInferred = sys.inferredSchemas?.[boundary.boundary];
        const ttComputedArgs = ttInferred && ttInferred.computedOrder.length > 0
          ? { computed: sys.dsl.byBoundaryName[boundary.boundary]?.state?.computed ?? [], computedOrder: ttInferred.computedOrder }
          : {};
        let rebuilt: ReturnType<typeof rebuildEntityAtVersion>;
        try {
          rebuilt = rebuildEntityAtVersion(
            targetId, controls.timeTravel.readAtVersion, boundary, sys.events, reqCel, logger,
            sys.tsReducerRegistry,
            ttComputedArgs.computed,
            ttComputedArgs.computedOrder,
          );
        } catch (err) {
          const mapped = mapErrorToStatus(err);
          send({ status: mapped.status, headers: mapped.headers ?? {}, body: mapped.body });
          return;
        }
        const headers = { 'x-potemkin-read-at-version': String(controls.timeTravel.readAtVersion) };
        if (rebuilt === null) {
          send({ status: 404, headers, body: { error: 'ENTITY_ABSENCE', message: `entity ${targetId} not found at version ${controls.timeTravel.readAtVersion}` } });
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

    // q4v1: Boundary latency is applied BEFORE chaos+idempotency, mirroring
    // gateway.ts:675 which calls delay(resolveBoundaryLatencyMs(boundary.latency))
    // before the fault-rule eval (line 689) and idempotency check (line 739).
    // This ensures idempotency replays and chaos short-circuits still incur the
    // configured boundary delay — the same behaviour as the gateway path.
    const boundaryLatencyMs = resolveBoundaryLatencyMs(boundary.latency);
    await delay(boundaryLatencyMs);

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
        // Boundary latency was already applied above; add only the rule's own
        // delay_ms delta so it is not double-counted (mirrors gateway.ts:702).
        await delay(faultResponse.delay_ms ?? 0);
        const headers = lowercaseHeaderMap(faultResponse.headers);
        send({ status: faultResponse.status, headers, body: isHead ? null : (faultResponse.body ?? null) });
        return;
      }
    }

    if (chaos.response !== undefined || chaos.dropConnection === true) {
      await delay(chaos.extraLatencyMs);
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

    // Idempotency check. Key is scoped to the resolved actor id (no cross-actor
    // replay). `check` atomically reserves a pending slot on a miss so a
    // concurrent second request with the same key WAITS rather than double-
    // executing (TOCTOU). The reservation is resolved via record()/release().
    const idempotencyKey = readForwardedHeader(fwd.headers, 'idempotency-key');
    const idempotencyCfg = sys.dsl.idempotency;
    const idempotencyEnabled = idempotencyCfg?.enabled ?? false;
    const idempotencyActorId = actor?.id ?? '';
    let idempotencyReserved = false;

    if (idempotencyEnabled && idempotencyKey && intent !== 'query') {
      const store = sys.idempotencyStore;
      const requestBody: JsonValue = fwd.body ?? {};
      const hashIncludesBody = idempotencyCfg?.hashIncludesBody ?? true;
      const checkParams = { actorId: idempotencyActorId, method, path, idempotencyKey, body: requestBody, hashIncludesBody };

      const replay = (cached: CachedResponse): void => {
        // Re-emit the recorded _patches so a masked/hateoas response stays masked
        // on replay (the plugin applies the patches to the base body).
        send({
          status: cached.status,
          headers: { ...(cached.headers ?? {}), 'x-idempotency-replay': 'true' },
          body: isHead ? null : (cached.body ?? null),
          ...(cached.patches !== undefined && !isHead ? { _patches: cached.patches } : {}),
        });
      };

      try {
        for (;;) {
          const checkResult = store.check(checkParams);
          if (checkResult.kind === 'hit') {
            replay(checkResult.response);
            return;
          }
          if (checkResult.kind === 'wait') {
            const waited = await checkResult.wait;
            if (waited !== null) {
              replay(waited);
              return;
            }
            continue;
          }
          idempotencyReserved = true;
          break;
        }
      } catch (err) {
        if (err instanceof IdempotencyConflictError) {
          send({ status: 409, headers: {}, body: err.toJSON() as JsonValue });
          return;
        }
        throw err;
      }
    }

    /** Release the idempotency reservation (if held) so concurrent waiters re-execute. */
    const releaseIdempotency = (): void => {
      if (idempotencyReserved && idempotencyKey) {
        idempotencyReserved = false;
        sys.idempotencyStore.release({
          actorId: idempotencyActorId,
          method,
          path,
          idempotencyKey,
          body: fwd.body ?? {},
          hashIncludesBody: idempotencyCfg?.hashIncludesBody ?? true,
        });
      }
    };

    // Apply chaos extra latency on the normal (non-short-circuit) path.
    // Boundary latency was already applied above.
    if (chaos.extraLatencyMs > 0) await delay(chaos.extraLatencyMs);

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
          resetEpoch: sys.resetEpoch,
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
      // Release the idempotency reservation so concurrent waiters re-execute.
      releaseIdempotency();
      logger.error({ err }, 'UoW execution error in forwarding handler');
      const mapped = mapErrorToStatus(err);
      send({ status: mapped.status, headers: { ...(mapped.headers ?? {}), 'x-specmatic-result': 'failure' }, body: mapped.body });
      return;
    }

    // Attach response snapshot to committed events so saga compensation and
    // time-travel reads see event.response — mirroring gateway lines 896-900.
    if (!controls.transparency.dryRun && result.events.length > 0) {
      sys.events.attachResponse(
        result.events.map(e => e.eventId),
        { status: result.status, body: result.body, headers: { ...(result.headers ?? {}) } },
      );
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
        // Apply the boundary mask removes so masked fields do not leak via
        // _events on a normal (non-admin) response.
        payload: maskEventPayload(e.payload as JsonValue, boundary.mask ?? []), causedBy: e.causedBy,
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
    // matches exactly what the caller received (HATEOAS, mask, format, trace headers
    // applied). The _patches envelope is recorded too so a replay re-emits the same
    // mask/HATEOAS patches — otherwise the plugin would serialize the unmasked base
    // body on replay, leaking masked fields. Recording resolves the pending
    // reservation; a dry-run releases it instead (it never persists an entry).
    if (idempotencyEnabled && idempotencyKey && intent !== 'query' && controls.transparency.dryRun !== true) {
      const store = sys.idempotencyStore;
      const requestBody: JsonValue = fwd.body ?? {};
      const hashIncludesBody = idempotencyCfg?.hashIncludesBody ?? true;
      const ttlMs = (idempotencyCfg?.ttlSeconds ?? 86400) * 1000;
      try {
        store.record({
          actorId: idempotencyActorId,
          method, path, idempotencyKey, body: requestBody, hashIncludesBody,
          response: {
            status: result.status,
            body: outBody ?? null,
            headers: responseHeaders,
            ...(patches !== undefined ? { patches } : {}),
          },
          ttlMs,
        });
        idempotencyReserved = false;
      } catch {
        logger.warn({ idempotencyKey }, 'Failed to record idempotency entry in forwarding handler');
      }
    } else {
      // Dry-run (or otherwise not recording): drop the reservation so waiters proceed.
      releaseIdempotency();
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

/**
 * Parse an admin actor-override / impersonate header value of the form
 * `<id>:<scope1>,<scope2>,...` into an Actor. Splits on the FIRST colon only so
 * resource:action scopes (e.g. `vault:write`) survive. Mirrors actorExtractor.ts.
 */
function parseActorOverride(value: string): Actor {
  const colonIdx = value.indexOf(':');
  if (colonIdx === -1) {
    return { id: value || 'unknown', scopes: [] };
  }
  const id = value.slice(0, colonIdx);
  const scopesStr = value.slice(colonIdx + 1);
  return { id: id || 'unknown', scopes: scopesStr.split(',').map(s => s.trim()).filter(Boolean) };
}

/**
 * Enforce the matched GET operation's required_scopes against the resolved actor
 * BEFORE any time-travel read short-circuit. Mirrors the pattern matcher's RBAC
 * gate so a time-travel read cannot bypass scope enforcement.
 *
 * @throws {AuthenticationRequiredError} (401) / {AuthorizationDeniedError} (403)
 */
function enforceGetReadScopes(
  sys: BootedSystem,
  boundary: BoundaryConfig,
  contractPath: string,
  actor: Actor | undefined,
): void {
  const operationId = lookupOperationId(sys.openapi, contractPath, 'GET');
  if (operationId === undefined) return;
  for (const behavior of boundary.behaviors) {
    if (behavior.match.operationId !== operationId) continue;
    if (behavior.match.requiredScopes && behavior.match.requiredScopes.length > 0) {
      checkScopes(actor, behavior.match.requiredScopes, behavior.name);
    }
  }
}

/**
 * Remove the boundary `mask:` field names from an echoed event payload so masked
 * fields cannot leak through the X-Potemkin-Include-Events `_events` envelope.
 */
function maskEventPayload(payload: JsonValue, maskFields: readonly string[]): JsonValue {
  if (maskFields.length === 0) return payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const out: Record<string, JsonValue> = { ...(payload as Record<string, JsonValue>) };
  for (const field of maskFields) delete out[field];
  return out;
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

    const itemLc = lowercaseHeaders(fwd.headers);
    let itemTargetId: string | null = extractEntityKey({
      boundary,
      pathParams: route.pathParams,
      queryParams: fwd.query,
      headers: itemLc,
      body: item as unknown,
    });
    if (intent === 'creation' && itemTargetId === null) {
      const genRule = boundary.identity?.creation?.generate;
      if (genRule) {
        itemTargetId = resolveCreationTargetId({
          generate: genRule,
          payload: (item ?? {}) as JsonObject,
          boundary: boundary.boundary,
          cel: reqCel,
          scriptRegistry: sys.dsl.scriptRegistry,
          now: () => new Date().toISOString(),
          logger: sys.logger,
        });
      }
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
      headers: itemLc,
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
          resetEpoch: sys.resetEpoch,
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
