/**
 * Express handler for the /_engine/forward and /_engine/health endpoints.
 *
 * POST /_engine/forward
 *   Accepts a ForwardedRequest in the JSON body, runs it through the same
 *   CQRS/ES pipeline that the regular HTTP gateway uses (matchRoute →
 *   translateIntent → targetId resolution → executeUnitOfWork), and returns
 *   a ForwardedResponse.
 *
 * GET /_engine/health
 *   Returns a lightweight health-check payload.
 */

import type { RequestHandler, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import type { BootedSystem } from '../engine/boot.js';
import type { ForwardedRequest, ForwardedResponse, RoutesDiscoveryResponse, FixturesResponse } from './types.js';
import { deriveFixtures } from './fixtures.js';
import type { Command, Intent, JsonObject, JsonValue } from '../types.js';
import { matchRoute } from '../contract/router.js';
import { translateIntent } from '../engine/router.js';
import { executeUnitOfWork } from '../engine/uow.js';
import { createSideEffectQueue } from '../engine/sideEffects.js';
import { extractFaultSignal } from '../engine/faultSim.js';
import { nextUuidv7 } from '../ids/uuidv7.js';
import { resolveActor, JwtValidationError } from '../identity/actorResolver.js';
import { applyResponseMutations, buildOperationLookup } from '../http/responseMutations.js';
import { parseControlHeaders } from '../http/controlHeaders.js';
import { applyPaginationStyle, applyResponseFormat } from '../http/responseFormat.js';
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

// Package version is baked in at load time from package.json.
// We use a dynamic require here because this is CJS/ts-jest territory and
// the JSON import is the most portable cross-compile approach.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PKG_VERSION: string = (require('../../package.json') as { version: string }).version;

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

/**
 * Case-insensitively read a header from a forwarded headers map.
 *
 * The forwarding contract (forwarding/types.ts) documents lowercase keys, but
 * the engine must not 500 / silently mis-route when a caller forwards original
 * casing (e.g. `If-Match`, `Authorization`, `Idempotency-Key`). We first try the
 * exact lowercase key (the documented fast path) and fall back to a
 * case-insensitive scan only when that misses.
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

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Error → HTTP status mapping (mirrors gateway.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Core forwarding handler
// ---------------------------------------------------------------------------

/**
 * Create an Express request handler that implements the forwarding endpoint.
 * The handler reads a ForwardedRequest from req.body and returns a ForwardedResponse.
 */
export function createForwardingHandler(sys: BootedSystem): RequestHandler {
  return async function forwardingHandler(req: Request, res: Response): Promise<void> {
    // 1. Validate the forwarded request body.
    if (!isForwardedRequest(req.body)) {
      res.status(400).json({
        error: 'MALFORMED_FORWARDED_REQUEST',
        message: 'Request body must be a ForwardedRequest object with method, path, headers, query, and body fields.',
      });
      return;
    }

    const fwd: ForwardedRequest = req.body as ForwardedRequest;

    // Normalise method to uppercase.
    const method = fwd.method.toUpperCase();
    const path = fwd.path;

    // 2. Fault-sim: honour x-specmatic-fault forwarded in the fwd.headers.
    try {
      const fault = extractFaultSignal(fwd.headers as Record<string, string | string[] | undefined>);
      if (fault !== null) {
        sys.metrics.faultsSimulatedTotal.add(1);
        const fwdResponse: ForwardedResponse = {
          status: fault.status,
          headers: fault.headers ?? {},
          body: fault.body,
        };
        res.status(200).json(fwdResponse);
        return;
      }
    } catch (err) {
      const mapped = mapErrorToStatus(err);
      res.status(200).json({ status: mapped.status, headers: mapped.headers ?? {}, body: mapped.body } satisfies ForwardedResponse);
      return;
    }

    // 3. Match route against OpenAPI.
    const route = matchRoute(sys.openapi, method, path);
    if (route === null) {
      const fwdResponse: ForwardedResponse = {
        status: 404,
        headers: {},
        body: { error: 'NO_ROUTE', path },
      };
      res.status(200).json(fwdResponse);
      return;
    }

    // 4. Resolve boundary and intent.
    const boundary = sys.dsl.byContractPath[route.contractPath];
    if (boundary === undefined) {
      const fwdResponse: ForwardedResponse = {
        status: 404,
        headers: {},
        body: { error: 'NO_BOUNDARY', contractPath: route.contractPath },
      };
      res.status(200).json(fwdResponse);
      return;
    }

    let intent: Intent;
    try {
      intent = translateIntent({ method, boundary });
    } catch (err) {
      const mapped = mapErrorToStatus(err);
      const fwdResponse: ForwardedResponse = { status: mapped.status, headers: mapped.headers ?? {}, body: mapped.body };
      res.status(200).json(fwdResponse);
      return;
    }

    // 5. Resolve targetId from path params; generate one for creation commands if needed.
    let targetId: string | null = route.pathParams['id'] ?? null;
    if (intent === 'creation' && targetId === null) {
      const genRule = boundary.identity?.creation?.generate;
      if (genRule === '$uuidv7()') {
        targetId = nextUuidv7();
      }
    }

    // 6. Resolve actor from the forwarded Authorization header per auth mode
    //    (F1: jwt → validateJwt; else the legacy bearer shortcut).
    //    NOTE (potemkin-0la): the /_engine/forward path is JWT/Bearer-only — it
    //    resolves the actor solely from the forwarded `authorization` header.
    //    Cookie/session-mode auth (auth.mode: session) is NOT reachable here: a
    //    ForwardedRequest carries no session cookie and createSessionAuthMiddleware
    //    runs only on the gateway's own contract routes, not on /_engine/forward.
    //    Plugin-forwarded traffic must therefore present a Bearer/JWT credential.
    let actor;
    try {
      actor = resolveActor(readForwardedHeader(fwd.headers, 'authorization'), sys.dsl.auth) ?? undefined;
    } catch (e) {
      if (e instanceof JwtValidationError) {
        // Return the ForwardedResponse envelope (HTTP 200 carrying the real
        // status) like every other branch here — a bare 401 would leave the
        // envelope's `status` field undefined for the plugin/caller to read.
        const fwdResponse: ForwardedResponse = {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer' },
          body: { error: 'UNAUTHENTICATED', message: e.message, details: { code: e.code } },
        };
        res.status(200).json(fwdResponse);
        return;
      }
      throw e;
    }

    // 7. Extract sequenceVersion from forwarded If-Match header (case-insensitive).
    const ifMatchValue = readForwardedHeader(fwd.headers, 'if-match');
    const sequenceVersion = ifMatchValue !== undefined
      ? Number(String(ifMatchValue).replace(/^"|"$/g, ''))
      : undefined;

    // 8. Extract fault signal from forwarded x-specmatic-fault header (already handled above,
    //    but the Command also carries faultSignal for the UoW fault-sim path).
    const faultHeaderRaw = readForwardedHeader(fwd.headers, 'x-specmatic-fault');

    // 8b. Parse X-Potemkin-* control headers. parseControlHeaders looks header
    //     constants up by their canonical lowercase name, so normalise the
    //     forwarded headers (which may carry original casing) to lowercase keys.
    const lowercasedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(fwd.headers)) {
      lowercasedHeaders[k.toLowerCase()] = v;
    }
    const controls = parseControlHeaders(lowercasedHeaders);

    // 9. Build Command.
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
      ...(faultHeaderRaw ? { faultSignal: faultHeaderRaw } : {}),
      ...(actor !== undefined ? { actor } : {}),
    };

    // 10. Idempotency check (mirrors gateway.ts logic).
    const idempotencyKey = readForwardedHeader(fwd.headers, 'idempotency-key');
    const idempotencyCfg = sys.dsl.idempotency;
    const idempotencyEnabled = idempotencyCfg?.enabled ?? false;

    if (idempotencyEnabled && idempotencyKey && intent !== 'query') {
      const store = sys.idempotencyStore;
      const requestBody: JsonValue = fwd.body ?? {};
      const hashIncludesBody = idempotencyCfg?.hashIncludesBody ?? true;

      try {
        const checkResult = store.check({
          method,
          path,
          idempotencyKey,
          body: requestBody,
          hashIncludesBody,
        });

        if (checkResult.hit) {
          const cached = checkResult.response;
          const fwdResponse: ForwardedResponse = {
            status: cached.status,
            headers: { ...(cached.headers ?? {}), 'x-idempotency-replay': 'true' },
            body: cached.body ?? null,
          };
          res.status(200).json(fwdResponse);
          return;
        }
      } catch (err) {
        if (err instanceof IdempotencyConflictError) {
          const fwdResponse: ForwardedResponse = { status: 409, headers: {}, body: err.toJSON() as JsonValue };
          res.status(200).json(fwdResponse);
          return;
        }
        throw err;
      }
    }

    // 11. Execute Unit of Work.
    const logger = sys.logger.child({ forwardedPath: path, forwardedMethod: method });

    // Mirror the gateway's side-effect wiring: outbound webhooks fire via the
    // injected transport (sys.webhookTransport); a bulk-transactional forwarded
    // request defers its post-commit sagas/webhooks into a batch-scoped queue so
    // they fire exactly once after a successful commit (and never against state
    // that an abort would discard).
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
          cel: sys.cel,
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
          // maxCascadeDepth=N allows N levels beyond the primary; the UoW counts
          // depth from 0 (primary), so pass N+1 to include the primary.
          ...(controls.sideEffects.maxCascadeDepth !== undefined
            ? { maxDepth: controls.sideEffects.maxCascadeDepth + 1 }
            : {}),
        }),
      );
      // Single-UoW forward: the command committed, so flush the deferred batch.
      deferred?.flush(logger);
    } catch (err) {
      // Aborted before commit — discard any enqueued side-effects so none fire.
      deferred?.discard();
      logger.error({ err }, 'UoW execution error in forwarding handler');
      const mapped = mapErrorToStatus(err);
      const fwdResponse: ForwardedResponse = {
        status: mapped.status,
        // X-Specmatic-Result: every UoW error path is a contract-test failure.
        headers: { ...(mapped.headers ?? {}), 'x-specmatic-result': 'failure' },
        body: mapped.body,
      };
      res.status(200).json(fwdResponse);
      return;
    }

    // 12. Build response headers including ETag for mutating commands.
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
      if (seqForEtag !== undefined) {
        responseHeaders['etag'] = '"' + String(seqForEtag) + '"';
      }
    }

    // 13. Record idempotency entry after successful execution (mirrors gateway.ts).
    if (idempotencyEnabled && idempotencyKey && intent !== 'query') {
      const store = sys.idempotencyStore;
      const requestBody: JsonValue = fwd.body ?? {};
      const hashIncludesBody = idempotencyCfg?.hashIncludesBody ?? true;
      const ttlMs = (idempotencyCfg?.ttlSeconds ?? 86400) * 1000;
      try {
        store.record({
          method,
          path,
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
        logger.warn({ idempotencyKey }, 'Failed to record idempotency entry in forwarding handler');
      }
    }

    // D4: compute response-mutation patches (HATEOAS/mask) + deprecation headers.
    // The base body is returned unchanged and the body patches are reported in
    // `_patches` for the plugin's response interceptor to re-apply (E1); the
    // deprecation/sunset/link headers are merged into the response headers.
    let patches: readonly import('../dsl/patches.js').JournalEntry[] | undefined;
    if (result.status >= 200 && result.status < 300 && result.body !== null && result.body !== undefined) {
      const pathItem = sys.openapi.paths[route.contractPath] as
        | Record<string, import('../contract/loader.js').OpenApiOperation | undefined>
        | undefined;
      const mutation = applyResponseMutations({
        body: result.body,
        boundary,
        operation: pathItem ? pathItem[method.toLowerCase()] : undefined,
        statusCode: result.status,
        operationLookup: buildOperationLookup(sys.openapi),
      });
      // ForwardedResponse header keys are lowercase by convention.
      for (const [k, v] of Object.entries(mutation.headers)) responseHeaders[k.toLowerCase()] = v;
      // Body-affecting patches only (hateoas/mask); deprecation went to headers.
      const bodyPatches = mutation.journal.filter((e) => e.source === 'hateoas' || e.source === 'mask');
      if (bodyPatches.length > 0) patches = bodyPatches;
    }

    // Tier 5: pagination style + response format — mirror gateway.ts ordering
    // (pagination first so HAL/JSON:API see the chosen collection shape), applied
    // to the base body for successful responses. Header keys are lowercased per
    // the ForwardedResponse convention used throughout this handler.
    let outBody: JsonValue | null | undefined = result.body;
    if (
      controls.format.paginationStyle !== undefined &&
      result.status >= 200 && result.status < 300 &&
      outBody !== null && outBody !== undefined
    ) {
      const paged = applyPaginationStyle(
        outBody,
        controls.format.paginationStyle,
        fwd.query,
        path,
      );
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

    // Tier 1: signal that dry-run executed (the UoW already suppressed event
    // append / side-effects because `controls` was passed into executeUnitOfWork).
    if (controls.transparency.dryRun === true) responseHeaders['x-potemkin-dry-run'] = 'true';

    // X-Specmatic-Result: mirror the gateway — success on 2xx, failure otherwise
    // (header keys are lowercase per the ForwardedResponse convention).
    responseHeaders['x-specmatic-result'] = result.status >= 200 && result.status < 300 ? 'success' : 'failure';

    const fwdResponse: ForwardedResponse = {
      status: result.status,
      headers: responseHeaders,
      body: outBody,
      ...(patches !== undefined ? { _patches: patches } : {}),
    };

    res.status(200).json(fwdResponse);
  };
}

// ---------------------------------------------------------------------------
// Health-check handler
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Routes discovery handler
// ---------------------------------------------------------------------------

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
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch === checksum) {
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
    res.setHeader('ETag', checksum);
    res.status(200).json(body);
  };
}

// ---------------------------------------------------------------------------
// Fixtures handler
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 hex checksum over the serialised FixtureStub list.
 * Stubs are sorted by their bound path before serialisation so the checksum
 * is deterministic regardless of insertion order.
 */
function computeFixturesChecksum(
  stubs: readonly import('./types.js').FixtureStub[],
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
  // Lazily cached fixture list — derived once at first request and reused.
  // The checksum doubles as the ETag for conditional requests.
  let cachedStubs: readonly import('./types.js').FixtureStub[] | null = null;
  let cachedChecksum: string | null = null;

  return function fixturesHandler(req: Request, res: Response): void {
    // Derive fixtures on first call and cache (they are a boot-time snapshot).
    if (cachedStubs === null) {
      cachedStubs = deriveFixtures(sys);
      cachedChecksum = computeFixturesChecksum(cachedStubs);
    }

    const checksum = cachedChecksum!;
    const ttlSeconds = resolveRoutesTtl();

    // Conditional request: respond 304 when the client's ETag matches.
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch === checksum) {
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
    res.setHeader('ETag', checksum);
    res.status(200).json(body);
  };
}
