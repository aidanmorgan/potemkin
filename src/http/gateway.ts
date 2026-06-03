/**
 * HTTP Gateway — Contract-aware ingestion pipeline (design §2.1, §4.1)
 *
 * Pipeline per inbound request:
 *  1. CORS preflight check — OPTIONS requests are handled immediately with 204 + CORS headers.
 *  2. Fault-signal check (x-specmatic-fault header) — short-circuit before any state access.
 *  3. Contract-route lookup (matchRoute) — 404 if no OpenAPI path matches, 405 if method unknown.
 *     HEAD requests are treated as GET (RFC 7231 §4.3.2): if HEAD, look up route as 'GET' and
 *     run the GET pipeline, then respond with the same status/headers but empty body.
 *  4. Request validation (ContractValidator.validateRequest) — 400 CONTRACT_VIOLATION on failure.
 *  5. Identity/intent resolution — translate HTTP method → Intent; derive or generate targetId.
 *  6. Command construction — typed Command built from request data.
 *  7. Unit-of-Work execution (executeUnitOfWork) — full CQRS/ES dispatch with 2PC commit.
 *  8. Error → HTTP status mapping (§3.x error codes to RFC-standard status codes).
 *  9. Response serialisation — status + headers + JSON body + optional ETag.
 *
 * CORS design: Access-Control-Allow-Origin is configurable via ALLOWED_ORIGINS env var
 * (comma-separated list; default '*'). All responses include CORS headers so that
 * browser clients can use the sim from any origin without a reverse proxy.
 *
 * OTel HTTP instrumentation is provided automatically by @opentelemetry/instrumentation-express
 * when initTracing() is called at process startup. We do NOT manually wrap request handlers;
 * instead we use withSpan() for business-logic spans (http.request) inside each handler.
 */

import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';
import type { JsonObject, JsonValue } from '../types.js';

/**
 * Re-exported alias for `Express` so that `index.ts` can continue to export `ExpressApp`
 * as the public HTTP application type without depending on the express typings directly.
 */
export type ExpressApp = Express;
import type { BootedSystem } from '../engine/boot.js';
import { registerAdminRoutes } from './adminRoutes.js';
import { extractFaultSignal } from '../engine/faultSim.js';
import { matchRoute, resolveVersion } from '../contract/router.js';
import { translateIntent } from '../engine/router.js';
import { extractEntityKey } from '../engine/keyExtractor.js';
import { executeUnitOfWork } from '../engine/uow.js';
import { createSideEffectQueue } from '../engine/sideEffects.js';
import { nextUuidv7 } from '../ids/uuidv7.js';
import { withSpan } from '../observability/tracing.js';
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
import type { Command, Intent } from '../types.js';
import { resolveActor, JwtValidationError } from '../identity/actorResolver.js';
import { createSessionAuthMiddleware, SESSION_ACTOR_KEY, SESSION_HANDLED_KEY } from './sessionAuth.js';
import type { Actor } from '../types.js';
import { createForwardingHandler, healthHandler, createRoutesHandler, createFixturesHandler } from '../forwarding/handler.js';
import { parseControlHeaders, applyMask } from './controlHeaders.js';
import { POTEMKIN_REQUEST_HEADERS } from './potemkinHeaders.js';
import { applyPaginationStyle, applyResponseFormat } from './responseFormat.js';
import { buildSecurityHeaders } from './securityHeaders.js';
import { evaluateFaultRules } from '../faults/index.js';
import { applyResponseMutations, buildOperationLookup } from './responseMutations.js';
import type { OpenApiOperation } from '../contract/loader.js';
import { rebuildEntityAtVersion, findEventById } from '../engine/timeTravel.js';
import { resolveBoundaryLatencyMs, delay, shouldReturnNotModified, lastModifiedFromBody, isSingleEntityBody, applyHateoasToQueryBody } from '../forwarding/responsePipeline.js';
import { resolveChaosHeaders, truncateBody } from './chaosHeaders.js';
import { getAllowedOrigin, isOriginAdmitted } from './cors.js';

/** Node.js normalises header names to lowercase; this is the lowercased If-Match header. */
const IF_MATCH_HEADER_LC = 'if-match';

/** Request property key under which the resolved API version is stashed by the versioning middleware. */
const RESOLVED_VERSION_KEY = '__potemkinResolvedVersion';

/**
 * Returns true when the request carries credentials: a Cookie header (session
 * auth) or an Authorization header (JWT/Bearer). Browsers that send credentialed
 * requests reject a wildcard `Access-Control-Allow-Origin: *` response, so we
 * must reflect the specific Origin instead and set Allow-Credentials: true.
 */
function isCredentialedRequest(req: Request): boolean {
  return Boolean(req.headers['cookie']) || Boolean(req.headers['authorization']);
}

const CORS_ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS';
const CORS_ALLOW_HEADERS = [
  'Content-Type',
  'Authorization',
  'If-Match',
  'Idempotency-Key',
  'x-specmatic-fault',
  ...POTEMKIN_REQUEST_HEADERS,
].join(', ');

/**
 * Convert an OpenAPI path template (/loans/{id}) to an Express route pattern (/loans/:id).
 */
function expressifyPath(contractPath: string): string {
  return contractPath.replace(/\{([^}]+)\}/g, ':$1');
}

/**
 * Create and configure the Express application that acts as the HTTP gateway.
 *
 * Responsibilities:
 *  - Parse JSON bodies.
 *  - Check for fault-simulation headers on every request.
 *  - Match incoming routes against the OpenAPI document.
 *  - Validate requests via ContractValidator.
 *  - Translate to Commands and dispatch to executeUnitOfWork.
 *  - Register admin routes via registerAdminRoutes.
 *  - Serialise ExecutionResult (or error) to the HTTP response.
 */
export function createGateway(sys: BootedSystem): Express {
  const app = express();

  // Parse JSON bodies — strict:false allows non-object/array top-level values; 5 MB limit.
  // type option extended to handle 'text/json' and 'application/*+json' variants.
  app.use(express.json({ strict: false, limit: '5mb', type: ['application/json', 'text/json', 'application/*+json'] }));

  // CORS middleware — add Access-Control-* headers to every response.
  // When the request carries credentials (Cookie or Authorization), browsers
  // require a specific reflected Origin (not '*') and Allow-Credentials: true.
  // We only reflect the origin and set Allow-Credentials when the requestOrigin
  // is admitted by the ALLOWED_ORIGINS allowlist — otherwise the allowlist would
  // be bypassed exactly for the cookie/JWT requests where it matters most.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestOrigin = req.headers['origin'] as string | undefined;
    const credentialed = isCredentialedRequest(req);
    const admitted = credentialed && isOriginAdmitted(requestOrigin);
    const origin = admitted ? requestOrigin! : getAllowedOrigin(requestOrigin);
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', CORS_ALLOW_METHODS);
    res.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
    if (admitted) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    next();
  });

  // Security headers — inject the configured global security response headers on
  // every response (applied via setHeader so they survive all handler branches).
  const securityHeaders = buildSecurityHeaders(sys.dsl.securityHeaders);
  if (Object.keys(securityHeaders).length > 0) {
    app.use((_req: Request, res: Response, next: NextFunction) => {
      for (const [name, value] of Object.entries(securityHeaders)) {
        res.setHeader(name, value);
      }
      next();
    });
  }

  // OPTIONS preflight handler — respond 204 immediately before any route matching.
  app.options('*', (req: Request, res: Response) => {
    const requestOrigin = req.headers['origin'] as string | undefined;
    const credentialed = isCredentialedRequest(req);
    const admitted = credentialed && isOriginAdmitted(requestOrigin);
    const origin = admitted ? requestOrigin! : getAllowedOrigin(requestOrigin);
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', CORS_ALLOW_METHODS);
    res.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
    if (admitted) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.status(204).end();
  });

  // API versioning — strip the matched version prefix from the request URL so
  // the downstream contract routes (registered with un-versioned paths) match,
  // and stash the resolved version so the handler can tag the response with
  // X-Potemkin-Version. Skipped for engine/admin control-plane paths.
  if (sys.dsl.versioning?.enabled) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/_engine') || req.path.startsWith('/_admin')) {
        next();
        return;
      }
      const resolution = resolveVersion(req.path, sys.dsl.versioning);
      (req as unknown as Record<string, unknown>)[RESOLVED_VERSION_KEY] = resolution.version;
      if (resolution.version !== undefined) {
        // Tag the response with the resolved version; survives every handler branch.
        res.setHeader('X-Potemkin-Version', resolution.version);
      }
      if (resolution.path !== req.path) {
        // Preserve any query string when rewriting the URL.
        const qIndex = req.url.indexOf('?');
        const query = qIndex >= 0 ? req.url.slice(qIndex) : '';
        req.url = resolution.path + query;
      }
      next();
    });
  }

  // Session/cookie auth (auth.mode: session) — intercepts the configured
  // login/logout paths and resolves the session actor + CSRF for every other
  // request. No-op (null) for jwt/simple/no-auth modes. Registered before the
  // contract routes so login/logout win and the resolved actor is visible.
  const sessionMiddleware = createSessionAuthMiddleware(sys.dsl.auth, sys.sessionStore);
  if (sessionMiddleware) {
    app.use(sessionMiddleware);
  }

  // Admin routes registered first so they always win over dynamic OpenAPI routes.
  registerAdminRoutes(app, sys);

  // /_engine/* routes — Kotlin Specmatic plugin forwarding surface.
  // Registered BEFORE the dynamic contract routes so they always win.
  app.post('/_engine/forward', express.json({ strict: false, limit: '5mb' }), createForwardingHandler(sys));
  app.get('/_engine/health', healthHandler);
  app.get('/_engine/routes', createRoutesHandler(sys));
  app.get('/_engine/fixtures', createFixturesHandler(sys));

  // POST /_engine/dsl (install/replay) + GET /_engine/state/:boundary/:id
  // for the new plugin↔engine wire contract.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mountEngineDslRoutes } = require('./engineDslRoutes.js');
  mountEngineDslRoutes(app, sys);

  // Register one catch-all route handler per OpenAPI contract path.
  for (const contractPath of Object.keys(sys.dsl.byContractPath)) {
    const expressPath = expressifyPath(contractPath);

    app.all(
      expressPath,
      // Wrap in an async handler that forwards uncaught errors to Express error middleware.
      (req: Request, res: Response, next: NextFunction) => {
        handleContractRequest(req, res, contractPath, sys)
          .catch(next);
      },
    );
  }

  // Catch-all 404 for paths not covered by any contract route.
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'NO_ROUTE', path: req.path });
  });

  // Body-parse error handler — express.json() sets 'body' on SyntaxError when JSON is malformed.
  // Must be declared before the generic error handler so it catches SyntaxError first.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && 'body' in err) {
      if (res.headersSent) return;
      res.setHeader('X-Specmatic-Result', 'failure');
      res.status(400).json({
        error: 'CONTRACT_VIOLATION',
        code: 'MALFORMED_JSON',
        message: err.message,
      });
      return;
    }
    next(err);
  });

  // Express error-handler middleware — catches anything forwarded via next(err).
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    sys.logger.error({ err }, 'Unhandled error in Express error handler');
    if (res.headersSent) return;
    res.status(500).json({ error: 'INTERNAL', message: err instanceof Error ? err.message : String(err) });
  });

  return app;
}

/**
 * Core handler logic extracted for clarity; executes the full pipeline for a single request.
 */
async function handleContractRequest(
  req: Request,
  res: Response,
  contractPath: string,
  sys: BootedSystem,
): Promise<void> {
  const requestId = nextUuidv7();
  // HEAD requests are handled as GET (RFC 7231 §4.3.2) — normalise the effective method.
  const isHead = req.method === 'HEAD';
  const effectiveMethod = isHead ? 'GET' : req.method;
  const logger = sys.logger.child({ requestId, method: req.method, path: req.path });

  await withSpan(sys.tracer, 'http.request', async (_span) => {
    // Fault simulation: check for x-specmatic-fault header first.
    const fault = extractFaultSignal(req.headers as Record<string, string | string[] | undefined>);
    if (fault !== null) {
      sys.metrics.faultsSimulatedTotal.add(1);
      if (fault.headers) {
        res.set(fault.headers);
      }
      if (isHead) {
        res.status(fault.status).end();
      } else {
        res.status(fault.status).json(fault.body);
      }
      return;
    }

    // HEAD is looked up as GET per RFC 7231 §4.3.2.
    const route = matchRoute(sys.openapi, effectiveMethod, req.path);
    if (route === null) {
      // The Express route matched the path template but no OpenAPI operation covers this method.
      // Distinguish: did path match but method not → 405; path itself unrecognised → 404.
      // Since we only register routes for known contractPaths, a null here means wrong method.
      res.status(405).json({ error: 'METHOD_NOT_ALLOWED', method: req.method, path: req.path });
      return;
    }

    // 4a. Parse X-Potemkin-* control headers once and route per-tier as needed.
    const controls = parseControlHeaders(req.headers as Record<string, string | string[] | undefined>);

    // Admin gating for Tier 3 actor-override / impersonate / Tier 7 validation skips.
    const usesAdminGated =
      Boolean(controls.identity.actorOverride) ||
      Boolean(controls.identity.impersonate) ||
      controls.validation.skipRequestValidation === true ||
      controls.validation.skipResponseValidation === true ||
      controls.validation.allowAdditionalProperties === true;
    if (usesAdminGated) {
      let callerActor;
      try {
        callerActor = resolveActor(req.headers['authorization'] as string | undefined, sys.dsl.auth);
      } catch (e) {
        if (e instanceof JwtValidationError) {
          res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'UNAUTHENTICATED', message: e.message, details: { code: e.code } });
          return;
        }
        throw e;
      }
      const isAdmin = (callerActor?.scopes ?? []).includes('admin');
      if (!isAdmin) {
        // RFC 7235: 401 = not authenticated; 403 = authenticated but forbidden.
        const status = callerActor === null ? 401 : 403;
        res.status(status).json({ error: 'ADMIN_REQUIRED', message: 'admin scope required for this X-Potemkin-* header' });
        return;
      }
    }

    // Contract validation: use effectiveMethod so HEAD requests are validated as GET.
    // Tier 7: admin-gated skip.
    // Tier 2: a bulk-transactional array body is validated per-item inside the
    // bulk block below (the contract schema describes a single item, not the
    // array envelope), so skip the top-level whole-body validation here.
    const isBulkArrayBody =
      controls.sideEffects.bulkTransactional === true && Array.isArray(req.body);
    if (controls.validation.skipRequestValidation !== true && !isBulkArrayBody) {
      try {
        sys.validator.validateRequest(
          effectiveMethod,
          route.contractPath,
          (req.body as JsonValue | null | undefined) ?? {},
          req.query as Record<string, string | string[]>,
          route.pathParams,
        );
      } catch (err) {
        if (err instanceof ContractViolationError) {
          res.status(400).json({ error: 'CONTRACT_VIOLATION', details: err.details ?? err.message });
          return;
        }
        throw err;
      }
    }

    // Tier 1: clock offset + faker seed — per-request, immutable. A lightweight
    // sub-evaluator layers this request's X-Potemkin-Clock-Offset / -Seed on top
    // of the shared evaluator WITHOUT mutating it, so two concurrent requests
    // each observe their own offset/seed with no cross-request leak. All the
    // request-scoped CEL consumers below receive `reqCel` instead of `sys.cel`.
    const reqCel = sys.cel.withRequestContext({
      ...(controls.transparency.clockOffsetMs !== undefined ? { clockOffsetMs: controls.transparency.clockOffsetMs } : {}),
      ...(controls.transparency.seed !== undefined ? { seed: controls.transparency.seed } : {}),
    });

    // Tier 2: bulk-transactional — when the body is an array, execute each item
    // through the full CQRS/ES Unit of Work with all-or-nothing semantics. The
    // EventStore and StateGraph are snapshotted before the batch; the first item
    // that fails validation or a domain rule aborts the WHOLE batch
    // (400 BULK_TRANSACTION_ABORTED) and BOTH stores are rolled back so no prior
    // item is persisted. On full success every item is committed and observable
    // via GET /_admin/state.
    if (controls.sideEffects.bulkTransactional === true && Array.isArray(req.body)) {
      const items = req.body as JsonValue[];
      const bulkBoundary = sys.dsl.byContractPath[route.contractPath];
      const bulkIntent: Intent = translateIntent({ method: effectiveMethod, boundary: bulkBoundary });

      // Resolve the actor once for the whole batch (same auth rules as a single request).
      let bulkActor: Actor | undefined;
      {
        const bulkReqProps = req as unknown as Record<string, unknown>;
        if (bulkReqProps[SESSION_HANDLED_KEY] === true) {
          bulkActor = bulkReqProps[SESSION_ACTOR_KEY] as Actor | undefined;
        } else {
          try {
            bulkActor = resolveActor(req.headers['authorization'] as string | undefined, sys.dsl.auth) ?? undefined;
          } catch (e) {
            if (e instanceof JwtValidationError) {
              res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'UNAUTHENTICATED', message: e.message, details: { code: e.code } });
              return;
            }
            throw e;
          }
        }
      }

      // Snapshot both stores so a mid-batch failure can roll back fully.
      const eventSnapshot = sys.events.snapshot();
      const graphSnapshot = sys.graph.snapshot();

      // Defer every item's post-commit side-effects (sagas + webhooks) into one
      // batch-scoped queue. On full success the queue is flushed once (all fire);
      // on abort it is discarded so NO side-effect runs against state that the
      // rollback below throws away — preserving all-or-nothing semantics.
      const deferredSideEffects = createSideEffectQueue();

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

        // Per-item contract validation (unless admin-gated skip is in effect).
        if (controls.validation.skipRequestValidation !== true) {
          try {
            sys.validator.validateRequest(
              effectiveMethod, route.contractPath,
              item as JsonValue, req.query as Record<string, string | string[]>, route.pathParams,
            );
          } catch (err) {
            abortIndex = i;
            abortError = err instanceof ContractViolationError
              ? (typeof err.details === 'string' ? err.details : err.message)
              : (err instanceof Error ? err.message : 'item rejected');
            break;
          }
        }

        // Resolve a per-item targetId (path id for sub-paths; generated for creations).
        let itemTargetId: string | null = route.pathParams['id'] ?? null;
        if (bulkIntent === 'creation' && itemTargetId === null) {
          const genRule = bulkBoundary.identity?.creation?.generate;
          if (genRule === '$uuidv7()') itemTargetId = nextUuidv7();
        }

        const itemCommand: Command = {
          commandId: nextUuidv7(),
          boundary: bulkBoundary.boundary,
          intent: bulkIntent,
          targetId: itemTargetId,
          payload: item as JsonObject,
          queryParams: req.query as Record<string, string | string[]>,
          httpMethod: effectiveMethod,
          path: req.path,
          origin: 'inbound',
          depth: 0,
          headers: {},
          ...(bulkActor !== undefined ? { actor: bulkActor } : {}),
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
              deferSideEffects: deferredSideEffects,
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

      if (abortIndex !== null) {
        // Roll back every committed item so the batch is all-or-nothing, and
        // discard the deferred side-effects so none run against rolled-back state.
        deferredSideEffects.discard();
        sys.events.restore(eventSnapshot);
        sys.graph.restore(graphSnapshot);
        res.status(400).json({
          error: 'BULK_TRANSACTION_ABORTED',
          message: `bulk transaction aborted at item ${abortIndex}: ${abortError ?? 'unknown'}`,
          abortIndex,
        });
      } else {
        // Whole batch committed — now fire every deferred saga/webhook once.
        deferredSideEffects.flush(logger);
        // Route the created-array through the same mask → pagination → format
        // pipeline single responses use, so X-Potemkin-Mask / -Pagination-Style /
        // -Response-Format are honoured for bulk results too.
        let bulkBody: JsonValue = results;
        const bulkHeaders: Record<string, string> = {};
        if (controls.format.maskFields && controls.format.maskFields.length > 0) {
          const fields = controls.format.maskFields;
          bulkBody = (results as JsonValue[]).map((item) => applyMask(item, fields) as JsonValue);
        }
        if (controls.format.paginationStyle !== undefined) {
          const paged = applyPaginationStyle(
            bulkBody,
            controls.format.paginationStyle,
            req.query as Record<string, string | string[]>,
            req.path,
          );
          bulkBody = paged.body;
          Object.assign(bulkHeaders, paged.headers);
        }
        if (controls.format.responseFormat !== undefined) {
          bulkBody = applyResponseFormat(bulkBody, controls.format.responseFormat, bulkBoundary.boundary, req.path);
          bulkHeaders['X-Potemkin-Response-Format'] = controls.format.responseFormat;
        }
        for (const [k, v] of Object.entries(bulkHeaders)) res.setHeader(k, v);
        res.status(201).json(bulkBody);
      }
      return;
    }

    const boundary = sys.dsl.byContractPath[route.contractPath];
    // Use effectiveMethod so HEAD commands are translated the same as GET.
    const intent: Intent = translateIntent({ method: effectiveMethod, boundary });

    // Build the lowercased-header snapshot early so identity.key extraction
    // (which may read a request header) has access to it before targetId is resolved.
    const requestHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') requestHeaders[k.toLowerCase()] = v;
      else if (Array.isArray(v)) requestHeaders[k.toLowerCase()] = v[0] ?? '';
    }

    // Resolve targetId: when the boundary declares identity.key, delegate to
    // extractEntityKey (reads from header/payload/query/path); otherwise
    // fall back to the {id} path parameter (backwards-compatible default).
    let targetId: string | null = extractEntityKey({
      boundary,
      pathParams: route.pathParams,
      queryParams: req.query as Record<string, string | string[]>,
      headers: requestHeaders,
      body: req.body as unknown,
    });
    if (intent === 'creation' && targetId === null) {
      const genRule = boundary.identity?.creation?.generate;
      if (genRule === '$uuidv7()') {
        targetId = nextUuidv7();
      }
    }

    // Tier 4: time-travel intercepts for GET requests (read-at-version / replay-event).
    if (effectiveMethod === 'GET') {
      if (controls.timeTravel.readAtVersion !== undefined && targetId !== null) {
        const ttInferred = sys.inferredSchemas?.[boundary.boundary];
        const ttComputedArgs = ttInferred && ttInferred.computedOrder.length > 0
          ? { computed: sys.dsl.byBoundaryName[boundary.boundary]?.state?.computed ?? [], computedOrder: ttInferred.computedOrder }
          : {};
        const rebuilt = rebuildEntityAtVersion(
          targetId, controls.timeTravel.readAtVersion, boundary, sys.events, reqCel, logger,
          sys.tsReducerRegistry,
          ttComputedArgs.computed,
          ttComputedArgs.computedOrder,
        );
        const headers = { 'X-Potemkin-Read-At-Version': String(controls.timeTravel.readAtVersion) };
        if (rebuilt === null) {
          res.status(404).set(headers).json({ error: 'ENTITY_ABSENCE', message: `entity ${targetId} not found at version ${controls.timeTravel.readAtVersion}` });
        } else {
          res.status(200).set(headers).json(rebuilt);
        }
        return;
      }
      if (controls.timeTravel.replayEvent) {
        const evt = findEventById(controls.timeTravel.replayEvent, sys.events);
        const headers = { 'X-Potemkin-Replayed-Event': controls.timeTravel.replayEvent };
        if (!evt) {
          res.status(404).set(headers).json({ error: 'EVENT_NOT_FOUND', message: `event ${controls.timeTravel.replayEvent} not found` });
        } else {
          res.status(200).set(headers).json({
            eventId: evt.eventId,
            type: evt.type,
            aggregateId: evt.aggregateId,
            sequenceVersion: evt.sequenceVersion,
            timestamp: evt.timestamp,
            payload: evt.payload,
            causedBy: evt.causedBy,
          });
        }
        return;
      }
    }

    // Resolve actor per auth mode.
    //  - session mode: the session middleware already resolved the actor from
    //    the cookie (when present) onto the request; we use that and do NOT fall
    //    back to the Authorization header.
    //  - jwt mode: validateJwt; simple/no-auth: legacy bearer shortcut.
    let actor: Actor | undefined;
    const reqProps = req as unknown as Record<string, unknown>;
    const sessionHandled = reqProps[SESSION_HANDLED_KEY] === true;
    if (sessionHandled) {
      actor = reqProps[SESSION_ACTOR_KEY] as Actor | undefined;
    } else {
      try {
        actor = resolveActor(req.headers['authorization'] as string | undefined, sys.dsl.auth) ?? undefined;
      } catch (e) {
        if (e instanceof JwtValidationError) {
          res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'UNAUTHENTICATED', message: e.message, details: { code: e.code } });
          return;
        }
        throw e;
      }
    }
    // Tier 3: actor override / impersonate (admin-gated above) — format `<id>:<scope1>,<scope2>`.
    const adminOverride = controls.identity.actorOverride ?? controls.identity.impersonate;
    if (adminOverride) {
      const [id, scopesStr] = adminOverride.split(':', 2);
      actor = { id: id ?? 'unknown', scopes: (scopesStr ?? '').split(',').filter(Boolean) };
    }

    // If-Match may carry a quoted ETag value ("1") or an unquoted integer (1).
    // Strip optional surrounding double-quotes before parsing to an integer (RFC 7232).
    // Weak validators (W/"5") produce NaN — reject with 400 rather than passing NaN.
    const ifMatchRaw = req.headers[IF_MATCH_HEADER_LC];
    let sequenceVersion: number | undefined;
    if (ifMatchRaw !== undefined) {
      const parsed = Number(String(ifMatchRaw).replace(/^"|"$/g, ''));
      if (Number.isNaN(parsed)) {
        res.status(400).json({ error: 'INVALID_IF_MATCH', message: 'If-Match value is not a valid integer (weak validators are not supported)' });
        return;
      }
      sequenceVersion = parsed;
    }
    const command: Command = {
      commandId: nextUuidv7(),
      boundary: boundary.boundary,
      intent,
      targetId,
      payload: (req.body as JsonObject | null | undefined) ?? {},
      queryParams: req.query as Record<string, string | string[]>,
      httpMethod: effectiveMethod,
      path: req.path,
      sequenceVersion,
      origin: 'inbound',
      depth: 0,
      headers: requestHeaders,
      ...(actor !== undefined ? { actor } : {}),
    };

    // Boundary latency — apply the per-boundary `latency:` delay before any
    // response leaves this handler (fault short-circuit, idempotency replay, or
    // the normal UoW path), mirroring the forwarding pipeline so engine-direct
    // and plugin-forwarded traffic incur the same configured delay.
    await delay(resolveBoundaryLatencyMs(boundary.latency));

    // 6a-bis: DSL fault rules — evaluate the global `fault_rules:` against this
    // command (header / boundary / intent / CEL / probability matchers). On a
    // match, short-circuit with the configured status/body/headers BEFORE the
    // UoW so no state is mutated. The X-Potemkin-Skip-Dispatch control bypasses
    // fault injection so callers can deterministically opt out.
    const boundaryFaults = boundary.faults ?? [];
    const globalFaults = sys.dsl.faults ?? [];
    const dynamicFaults = sys.faultStore.all();
    if (
      (boundaryFaults.length > 0 || globalFaults.length > 0 || dynamicFaults.length > 0) &&
      controls.sideEffects.skipDispatch !== true
    ) {
      const faultResponse = evaluateFaultRules({
        command,
        boundaryFaults,
        globalFaults,
        dynamicFaults,
        cel: reqCel,
        state: command.targetId !== null ? sys.graph.get(command.targetId) : null,
        logger,
      });
      if (faultResponse !== null) {
        sys.metrics.faultsSimulatedTotal.add(1);
        // Boundary latency was already applied above (line ~675); add only the
        // rule's own delay_ms delta so it is not double-counted.
        await delay(faultResponse.delay_ms ?? 0);
        if (faultResponse.headers) res.set(faultResponse.headers);
        if (isHead) res.status(faultResponse.status).end();
        else res.status(faultResponse.status).json(faultResponse.body ?? null);
        return;
      }
    }

    // 6a-ter: Chaos headers — resolve X-Potemkin-* chaos primitives, mirroring
    // the forwarding handler. Evaluated after DSL faults so YAML fault_rules win
    // over header-driven chaos when both are present. Boundary latency was already
    // applied above so only chaos.extraLatencyMs is added here.
    const faultRules = [...globalFaults, ...boundaryFaults];
    const chaos = resolveChaosHeaders(requestHeaders, faultRules);

    if (chaos.response !== undefined || chaos.dropConnection === true) {
      await delay(chaos.extraLatencyMs);
      if (chaos.dropConnection === true) {
        res.socket?.destroy();
        return;
      }
      const cr = chaos.response!;
      let chaosBody: JsonValue | null | undefined = cr.body ?? null;
      if (chaos.bodyTruncateBytes !== undefined && chaosBody !== null && chaosBody !== undefined) {
        chaosBody = truncateBody(chaosBody, chaos.bodyTruncateBytes);
      }
      if (cr.headers) res.set(cr.headers);
      if (isHead) res.status(cr.status).end();
      else sendBody(res.status(cr.status), chaosBody);
      return;
    }

    // 6b. Idempotency check.
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    const idempotencyCfg = sys.dsl.idempotency;
    const idempotencyEnabled = idempotencyCfg?.enabled ?? false;

    if (idempotencyEnabled && idempotencyKey && intent !== 'query') {
      const store = sys.idempotencyStore;
      const requestBody: JsonValue = (req.body as JsonValue | null | undefined) ?? {};
      const hashIncludesBody = idempotencyCfg?.hashIncludesBody ?? true;

      try {
        const checkResult = store.check({
          method: effectiveMethod,
          path: req.path,
          idempotencyKey,
          body: requestBody,
          hashIncludesBody,
        });

        if (checkResult.hit) {
          const cached = checkResult.response;
          logger.debug({ idempotencyKey }, 'Idempotency replay — returning cached response');
          const replayHeaders: Record<string, string> = {
            ...(cached.headers ?? {}),
            'X-Idempotency-Replay': 'true',
          };
          if (isHead) {
            res.status(cached.status).set(replayHeaders).end();
          } else {
            res.status(cached.status).set(replayHeaders).json(cached.body ?? null);
          }
          return;
        }
      } catch (err) {
        if (err instanceof IdempotencyConflictError) {
          res.status(409).json(err.toJSON());
          return;
        }
        throw err;
      }
    }

    // Apply any chaos latency stacked with the already-applied boundary latency.
    if (chaos.extraLatencyMs > 0) await delay(chaos.extraLatencyMs);

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
          // maxCascadeDepth=N means N levels of cascade allowed beyond the primary.
          // The UoW counts depth from 0 (primary), so we pass N+1 to allow the primary.
          ...(controls.sideEffects.maxCascadeDepth !== undefined
            ? { maxDepth: controls.sideEffects.maxCascadeDepth + 1 }
            : {}),
        }),
      );
    } catch (err) {
      logger.error({ err }, 'UoW execution error');
      // X-Specmatic-Result: every UoW error path is a contract-test failure.
      res.setHeader('X-Specmatic-Result', 'failure');
      // Error → HTTP mapping.
      if (err instanceof AuthenticationRequiredError) {
        res.status(401).json(err.toJSON());
      } else if (err instanceof AuthorizationDeniedError) {
        res.status(403).json(err.toJSON());
      } else if (err instanceof EntityAbsenceError) {
        res.status(404).json(err.toJSON());
      } else if (err instanceof EntityConflictError) {
        res.status(409).json(err.toJSON());
      } else if (err instanceof UnhandledOperationError) {
        res.status(422).json(err.toJSON());
      } else if (err instanceof ConcurrencyConflictError) {
        res.status(412).json(err.toJSON());
      } else if (err instanceof MissingPreconditionError) {
        res.status(428).json(err.toJSON());
      } else if (err instanceof InfiniteLoopError) {
        res.status(508).json(err.toJSON());
      } else if (err instanceof ContractViolationError) {
        res.status(400).json(err.toJSON());
      } else if (err instanceof InternalExecutionError) {
        res.status(500).json(err.toJSON());
      } else if (err instanceof FaultSimulatedError) {
        if (err.simulatedHeaders) {
          res.set(err.simulatedHeaders);
        }
        res.status(err.status).json(err.toJSON());
      } else {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: 'INTERNAL', message });
      }
      return;
    }

    const responseHeaders: Record<string, string> = { ...(result.headers ?? {}) };

    const isMutating = intent === 'mutation' || intent === 'creation';
    if (isMutating && result.events.length > 0) {
      // Use the last sequenceVersion for the primary aggregate (targetId), not the cascade events.
      const primaryAggregateId = command.targetId;
      const primaryEvents = primaryAggregateId !== null
        ? result.events.filter(e => e.aggregateId === primaryAggregateId)
        : result.events;
      const seqForEtag = primaryEvents.length > 0
        ? primaryEvents.at(-1)?.sequenceVersion
        : result.events.at(-1)?.sequenceVersion;
      if (seqForEtag !== undefined) {
        // RFC 7232 §2.3: ETag must be a quoted string.
        responseHeaders['ETag'] = '"' + String(seqForEtag) + '"';
      }
    }

    // Single-entity GET (RFC 7232): emit ETag + Last-Modified and honour
    // If-None-Match / If-Modified-Since → 304. Mirrors forwarding handler.
    const isSingleEntityGet =
      intent === 'query' && command.targetId !== null &&
      result.status >= 200 && result.status < 300 &&
      isSingleEntityBody(result.body);
    let lastModified: string | undefined;
    if (isSingleEntityGet && command.targetId !== null) {
      const seq = sys.events.currentSequenceVersion(command.targetId);
      if (seq > 0) responseHeaders['ETag'] = '"' + String(seq) + '"';
      lastModified = lastModifiedFromBody(result.body);
      if (lastModified !== undefined) responseHeaders['Last-Modified'] = lastModified;
    }

    if (isSingleEntityGet) {
      const notModified = shouldReturnNotModified({
        ...(responseHeaders['ETag'] !== undefined ? { etag: responseHeaders['ETag'] } : {}),
        ...(lastModified !== undefined ? { lastModified } : {}),
        ...(req.headers['if-none-match'] !== undefined
          ? { ifNoneMatch: req.headers['if-none-match'] as string } : {}),
        ...(req.headers['if-modified-since'] !== undefined
          ? { ifModifiedSince: req.headers['if-modified-since'] as string } : {}),
      });
      if (notModified) {
        const condHeaders: Record<string, string> = {};
        if (responseHeaders['ETag'] !== undefined) condHeaders['ETag'] = responseHeaders['ETag'];
        if (responseHeaders['Last-Modified'] !== undefined) condHeaders['Last-Modified'] = responseHeaders['Last-Modified'];
        res.status(304).set(condHeaders).end();
        return;
      }
    }

    // Attach response snapshot to the committed events for reducer chaining.
    if (!controls.transparency.dryRun && result.events.length > 0) {
      sys.events.attachResponse(
        result.events.map(e => e.eventId),
        { status: result.status, body: result.body, headers: { ...(result.headers ?? {}) } },
      );
    }

    // Tier 1/5/6: post-process response per X-Potemkin-* controls.
    let outBody: JsonValue | null | undefined = result.body;

    // Response mutations — HATEOAS _links injection, field masking
    // (DSL boundary.mask + the X-Potemkin-Mask-Fields control header), and
    // Deprecation/Sunset/Link headers — applied to successful contract responses.
    if (result.status >= 200 && result.status < 300 && outBody !== null && outBody !== undefined) {
      const opMethod = effectiveMethod.toLowerCase();
      const pathItem = sys.openapi.paths[route.contractPath] as
        | Record<string, OpenApiOperation | undefined>
        | undefined;
      const mutation = applyResponseMutations({
        body: outBody,
        boundary,
        operation: pathItem ? pathItem[opMethod] : undefined,
        statusCode: result.status,
        operationLookup: buildOperationLookup(sys.openapi),
      });
      outBody = mutation.body;
      Object.assign(responseHeaders, mutation.headers);
    }

    // HATEOAS — dynamic CEL-conditioned self + action links (global hateoas: block).
    // Applied after static boundary mutations so both link sets are present.
    if (intent === 'query' && result.status >= 200 && result.status < 300) {
      outBody = applyHateoasToQueryBody(outBody, boundary, sys.dsl, reqCel, req.query as Record<string, string | string[]>);
    }

    // Tier 5: the X-Potemkin-Mask control header REPLACES named fields with the
    // "[MASKED]" sentinel (distinct from the DSL boundary `mask:` block above,
    // which REMOVES fields).
    if (controls.format.maskFields && controls.format.maskFields.length > 0) {
      outBody = applyMask(outBody, controls.format.maskFields) as JsonValue | null | undefined;
    }

    // Tier 5: pagination style — re-shape collection responses between the
    // envelope and a bare array (+ Link header). Applied before response-format
    // so HAL/JSON:API see the chosen collection shape. Successful responses only.
    if (
      controls.format.paginationStyle !== undefined &&
      result.status >= 200 && result.status < 300 &&
      outBody !== null && outBody !== undefined
    ) {
      const paged = applyPaginationStyle(
        outBody,
        controls.format.paginationStyle,
        req.query as Record<string, string | string[]>,
        req.path,
      );
      outBody = paged.body;
      Object.assign(responseHeaders, paged.headers);
    }

    // Tier 5: response format — HAL / JSON:API body representation. `plain` is a
    // no-op. Successful responses only.
    if (
      controls.format.responseFormat !== undefined &&
      result.status >= 200 && result.status < 300 &&
      outBody !== null && outBody !== undefined
    ) {
      outBody = applyResponseFormat(outBody, controls.format.responseFormat, boundary.boundary, req.path);
      responseHeaders['X-Potemkin-Response-Format'] = controls.format.responseFormat;
    }

    // Tier 1: include events / echo debug envelope.
    const wantsEnvelope =
      controls.transparency.includeEvents === true || controls.transparency.echo === true;
    if (wantsEnvelope) {
      const base: Record<string, unknown> =
        outBody !== null && typeof outBody === 'object' && !Array.isArray(outBody)
          ? { ...(outBody as Record<string, unknown>) }
          : { value: outBody };
      if (controls.transparency.includeEvents === true) {
        base['_events'] = (result.events ?? []).map(e => ({
          eventId: e.eventId,
          type: e.type,
          aggregateId: e.aggregateId,
          sequenceVersion: e.sequenceVersion,
          timestamp: e.timestamp,
          payload: e.payload,
          causedBy: e.causedBy,
        }));
      }
      if (controls.transparency.echo === true) {
        base['_debug'] = {
          boundary: boundary.boundary,
          intent,
          targetId,
          dryRun: controls.transparency.dryRun === true,
          method: effectiveMethod,
          path: req.path,
        };
      }
      outBody = base as JsonValue;
    }

    // Tier 1: signal that dry-run executed.
    if (controls.transparency.dryRun === true) responseHeaders['X-Potemkin-Dry-Run'] = 'true';

    // X-Specmatic-Result: tag the Specmatic plugin's contract-test outcome.
    // Success on every non-error (2xx) UoW response; the error catch above tags
    // 'failure'. The body-parse error handler tags 'failure' for malformed JSON.
    responseHeaders['X-Specmatic-Result'] = result.status >= 200 && result.status < 300 ? 'success' : 'failure';

    // Tier 6: echo trace id / span name. NOTE: these are ECHO-ONLY — the supplied
    // X-Potemkin-Trace-Id / X-Potemkin-Span-Name are reflected back in the response
    // headers for caller correlation but are NOT wired into the OTel trace context
    // (the active span is created by withSpan('http.request') above; the caller does
    // not control its trace/span identifiers).
    if (controls.observability.traceId) responseHeaders['X-Potemkin-Trace-Id'] = controls.observability.traceId;
    if (controls.observability.spanName) responseHeaders['X-Potemkin-Span-Name'] = controls.observability.spanName;

    // 6c. Record idempotency entry after the full pipeline (HATEOAS, mask, format,
    // trace headers) so the cached body+headers match what the caller actually
    // received, and replays are identical to the original response.
    if (idempotencyEnabled && idempotencyKey && intent !== 'query' && controls.transparency.dryRun !== true) {
      const store = sys.idempotencyStore;
      const requestBody: JsonValue = (req.body as JsonValue | null | undefined) ?? {};
      const hashIncludesBody = idempotencyCfg?.hashIncludesBody ?? true;
      const ttlMs = (idempotencyCfg?.ttlSeconds ?? 86400) * 1000;
      try {
        store.record({
          method: effectiveMethod,
          path: req.path,
          idempotencyKey,
          body: requestBody,
          hashIncludesBody,
          response: {
            status: result.status,
            body: outBody ?? null,
            headers: responseHeaders,
          },
          ttlMs,
        });
      } catch {
        // Non-fatal: log but don't fail the response
        logger.warn({ idempotencyKey }, 'Failed to record idempotency entry');
      }
    }

    // X-Potemkin-Body-Truncate — unconditionally slice the serialised body to N
    // bytes, mirroring the forwarding handler which applies truncation after the
    // full pipeline regardless of whether other chaos headers are present.
    if (chaos.bodyTruncateBytes !== undefined && outBody !== null && outBody !== undefined) {
      outBody = truncateBody(outBody, chaos.bodyTruncateBytes);
    }

    // HEAD response: same status + headers as GET, but empty body (RFC 7231 §4.3.2).
    if (isHead) {
      res.status(result.status).set(responseHeaders).end();
    } else {
      sendBody(res.status(result.status).set(responseHeaders), outBody);
    }
  }, { 'http.method': req.method, 'http.path': req.path, requestId });
}

/**
 * Write a response body without double-serializing a chaos-truncated string.
 *
 * truncateBody() returns a raw string (a slice of JSON.stringify(body)) to
 * simulate a partial byte stream. Passing that string to res.json() would
 * JSON.stringify it again, wrapping it in quotes and escape characters.
 * When the body is already a string (i.e. it was truncated), write the raw
 * bytes directly with Content-Type: application/json. Otherwise delegate to
 * the standard res.json() path which handles serialisation.
 */
function sendBody(res: Response, body: JsonValue | null | undefined): void {
  if (typeof body === 'string') {
    res.setHeader('Content-Type', 'application/json');
    res.end(body);
  } else {
    res.json(body);
  }
}
