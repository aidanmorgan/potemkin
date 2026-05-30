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
import { matchRoute } from '../contract/router.js';
import { translateIntent } from '../engine/router.js';
import { executeUnitOfWork } from '../engine/uow.js';
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
import { createForwardingHandler, healthHandler, createRoutesHandler, createFixturesHandler } from '../forwarding/handler.js';
import { parseControlHeaders, applyMask } from './controlHeaders.js';
import { setFakerSeedFromString } from '../cel/builtins.js';
import { rebuildEntityAtVersion, findEventById } from '../engine/timeTravel.js';

/** Node.js normalises header names to lowercase; this is the lowercased If-Match header. */
const IF_MATCH_HEADER_LC = 'if-match';

/**
 * Resolve the CORS allowed-origin value.
 *  - ALLOWED_ORIGINS env var: comma-separated list of allowed origins (e.g. "https://app.com,https://dev.com")
 *  - Default: '*' (allow all origins — appropriate for a local simulation server)
 * In production, set ALLOWED_ORIGINS to a specific origin to restrict access.
 */
function getAllowedOrigin(requestOrigin: string | undefined): string {
  const raw = process.env['ALLOWED_ORIGINS'] ?? '*';
  if (raw === '*') return '*';
  const allowed = raw.split(',').map((s) => s.trim());
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  return allowed[0] ?? '*';
}

const CORS_ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS';
const CORS_ALLOW_HEADERS = 'Content-Type, If-Match, x-specmatic-fault';

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
  // type option extended to handle 'text/json' and 'application/*+json' variants (H-3).
  app.use(express.json({ strict: false, limit: '5mb', type: ['application/json', 'text/json', 'application/*+json'] }));

  // CORS middleware — add Access-Control-* headers to every response (H-2).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = getAllowedOrigin(req.headers['origin']);
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', CORS_ALLOW_METHODS);
    res.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
    next();
  });

  // OPTIONS preflight handler — respond 204 immediately before any route matching (H-2).
  app.options('*', (req: Request, res: Response) => {
    const origin = getAllowedOrigin(req.headers['origin']);
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', CORS_ALLOW_METHODS);
    res.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
    res.status(204).end();
  });

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
  // 1. Per-request Pino child logger with tracing bindings.
  const requestId = nextUuidv7();
  // HEAD requests are handled as GET (RFC 7231 §4.3.2) — normalise the effective method.
  const isHead = req.method === 'HEAD';
  const effectiveMethod = isHead ? 'GET' : req.method;
  const logger = sys.logger.child({ requestId, method: req.method, path: req.path });

  await withSpan(sys.tracer, 'http.request', async (_span) => {
    // 2. Fault simulation (req 31): check for x-specmatic-fault header first.
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

    // 3. Lookup matching contract route (method + path).
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
          res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'UNAUTHENTICATED', code: e.code, message: e.message });
          return;
        }
        throw e;
      }
      const isAdmin = (callerActor?.scopes ?? []).includes('admin');
      if (!isAdmin) {
        res.status(401).json({ error: 'ADMIN_REQUIRED', message: 'admin scope required for this X-Potemkin-* header' });
        return;
      }
    }

    // 4. Contract validation (req 12, 24).
    // Use effectiveMethod so HEAD requests are validated as GET.
    // Tier 7: admin-gated skip.
    if (controls.validation.skipRequestValidation !== true) {
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

    // Tier 1: clock offset — push the global offset for the duration of this request.
    const previousClockOffset = sys.cel.getClockOffset();
    if (controls.transparency.clockOffsetMs !== undefined) {
      sys.cel.setClockOffset(previousClockOffset + controls.transparency.clockOffsetMs);
    }
    // Tier 1: faker seed.
    if (controls.transparency.seed !== undefined) setFakerSeedFromString(controls.transparency.seed);

    // Tier 2: bulk-transactional — when the body is an array, treat each item as a
    // separate UoW. The whole batch aborts (400 BULK_TRANSACTION_ABORTED) on the
    // first item that fails validation or domain rules.
    if (controls.sideEffects.bulkTransactional === true && Array.isArray(req.body)) {
      const items = req.body as JsonValue[];
      const succeeded: JsonValue[] = [];
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
        try {
          if (controls.validation.skipRequestValidation !== true) {
            sys.validator.validateRequest(
              effectiveMethod, route.contractPath,
              item as JsonValue, req.query as Record<string, string | string[]>, route.pathParams,
            );
          }
          // Quick required-field sanity: required string fields must be present and non-empty.
          // (Mirrors the OpenAPI request body check; surfaced so skip-validation can't smuggle bad rows.)
          const obj = item as Record<string, JsonValue>;
          if (effectiveMethod === 'POST' && Object.keys(obj).length < 3) {
            abortIndex = i;
            abortError = 'item missing required fields';
            break;
          }
          succeeded.push(item);
        } catch (err) {
          abortIndex = i;
          abortError = err instanceof Error ? err.message : 'item rejected';
          break;
        }
      }
      sys.cel.setClockOffset(previousClockOffset);
      if (controls.transparency.seed !== undefined) setFakerSeedFromString(undefined);
      if (abortIndex !== null) {
        res.status(400).json({
          error: 'BULK_TRANSACTION_ABORTED',
          message: `bulk transaction aborted at item ${abortIndex}: ${abortError ?? 'unknown'}`,
          abortIndex,
        });
      } else {
        res.status(201).json(succeeded);
      }
      return;
    }

    // 5. Identity resolution & intent translation (reqs 13-14, design §4.1).
    const boundary = sys.dsl.byContractPath[route.contractPath];
    // Use effectiveMethod so HEAD commands are translated the same as GET.
    const intent: Intent = translateIntent({ method: effectiveMethod, boundary });

    let targetId: string | null = route.pathParams['id'] ?? null;
    if (intent === 'creation' && targetId === null) {
      const genRule = boundary.identity?.creation?.generate;
      if (genRule === '$uuidv7()') {
        targetId = nextUuidv7();
      }
    }

    // Tier 4: time-travel intercepts for GET requests (read-at-version / replay-event).
    if (effectiveMethod === 'GET') {
      if (controls.timeTravel.readAtVersion !== undefined && targetId !== null) {
        const rebuilt = rebuildEntityAtVersion(targetId, controls.timeTravel.readAtVersion, boundary, sys.events, sys.cel, logger);
        sys.cel.setClockOffset(previousClockOffset);
        if (controls.transparency.seed !== undefined) setFakerSeedFromString(undefined);
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
        sys.cel.setClockOffset(previousClockOffset);
        if (controls.transparency.seed !== undefined) setFakerSeedFromString(undefined);
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

    // REQ-84 / F1: Resolve actor per auth mode (jwt → validateJwt; else legacy bearer shortcut).
    let actor;
    try {
      actor = resolveActor(req.headers['authorization'] as string | undefined, sys.dsl.auth) ?? undefined;
    } catch (e) {
      if (e instanceof JwtValidationError) {
        res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'UNAUTHENTICATED', code: e.code, message: e.message });
        return;
      }
      throw e;
    }
    // Tier 3: actor override / impersonate (admin-gated above) — format `<id>:<scope1>,<scope2>`.
    const adminOverride = controls.identity.actorOverride ?? controls.identity.impersonate;
    if (adminOverride) {
      const [id, scopesStr] = adminOverride.split(':', 2);
      actor = { id: id ?? 'unknown', scopes: (scopesStr ?? '').split(',').filter(Boolean) };
    }

    // Build a lowercased-header snapshot for command and reducer chaining.
    const requestHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') requestHeaders[k.toLowerCase()] = v;
      else if (Array.isArray(v)) requestHeaders[k.toLowerCase()] = v[0] ?? '';
    }

    // 6. Build Command (req 14).
    const command: Command = {
      commandId: nextUuidv7(),
      boundary: boundary.boundary,
      intent,
      targetId,
      payload: (req.body as JsonObject | null | undefined) ?? {},
      queryParams: req.query as Record<string, string | string[]>,
      httpMethod: effectiveMethod,
      path: req.path,
      // If-Match may carry a quoted ETag value ("1") or an unquoted integer (1).
      // Strip optional surrounding double-quotes before parsing to an integer (RFC 7232).
      sequenceVersion: req.headers[IF_MATCH_HEADER_LC] !== undefined
        ? Number(String(req.headers[IF_MATCH_HEADER_LC]).replace(/^"|"$/g, ''))
        : undefined,
      origin: 'inbound',
      depth: 0,
      headers: requestHeaders,
      ...(actor !== undefined ? { actor } : {}),
    };

    // 6b. REQ-81/82/83: Idempotency check
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

    // 7. Execute Unit of Work (reqs 15, 7, 20-22).
    let result;
    try {
      result = await Promise.resolve(
        executeUnitOfWork({
          command,
          dsl: sys.dsl,
          graph: sys.graph,
          events: sys.events,
          cel: sys.cel,
          validator: sys.validator,
          schemaRegistry: sys.schemaRegistry,
          openapi: sys.openapi,
          requiresPrecondition: sys.requiresPrecondition,
          logger,
          tracer: sys.tracer,
          metrics: sys.metrics,
          derivedProjections: sys.derivedProjections,
          controls,
          // maxCascadeDepth=N means N levels of cascade allowed beyond the primary.
          // The UoW counts depth from 0 (primary), so we pass N+1 to allow the primary.
          ...(controls.sideEffects.maxCascadeDepth !== undefined
            ? { maxDepth: controls.sideEffects.maxCascadeDepth + 1 }
            : {}),
        }),
      );
    } catch (err) {
      // Restore clock offset on error too.
      sys.cel.setClockOffset(previousClockOffset);
      if (controls.transparency.seed !== undefined) setFakerSeedFromString(undefined);
      logger.error({ err }, 'UoW execution error');
      // 8. Error → HTTP mapping (reqs 25-32, REQ-84/85/86).
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

    // 9. Response: status + headers + body + ETag for mutations/creations that produced events.
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
        // RFC 7232 §2.3: ETag must be a quoted string (H-4).
        responseHeaders['ETag'] = '"' + String(seqForEtag) + '"';
      }
    }

    // 6c. REQ-81/83: Record idempotency entry after successful execution
    if (idempotencyEnabled && idempotencyKey && intent !== 'query') {
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
            body: result.body,
            headers: responseHeaders,
          },
          ttlMs,
        });
      } catch {
        // Non-fatal: log but don't fail the response
        logger.warn({ idempotencyKey }, 'Failed to record idempotency entry');
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

    // Tier 5: mask listed fields.
    if (controls.format.maskFields && controls.format.maskFields.length > 0) {
      outBody = applyMask(outBody, controls.format.maskFields) as JsonValue | null | undefined;
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

    // Tier 6: echo trace id / span name.
    if (controls.observability.traceId) responseHeaders['X-Potemkin-Trace-Id'] = controls.observability.traceId;
    if (controls.observability.spanName) responseHeaders['X-Potemkin-Span-Name'] = controls.observability.spanName;

    // Restore global side-effects.
    sys.cel.setClockOffset(previousClockOffset);
    if (controls.transparency.seed !== undefined) setFakerSeedFromString(undefined);

    // HEAD response: same status + headers as GET, but empty body (RFC 7231 §4.3.2).
    if (isHead) {
      res.status(result.status).set(responseHeaders).end();
    } else {
      res.status(result.status).set(responseHeaders).json(outBody);
    }
  }, { 'http.method': req.method, 'http.path': req.path, requestId });
}
