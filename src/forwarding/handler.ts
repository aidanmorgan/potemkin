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
import type { BootedSystem } from '../engine/boot.js';
import type { ForwardedRequest, ForwardedResponse } from './types.js';
import type { Command, Intent, JsonObject, JsonValue } from '../types.js';
import { matchRoute } from '../contract/router.js';
import { translateIntent } from '../engine/router.js';
import { executeUnitOfWork } from '../engine/uow.js';
import { extractFaultSignal } from '../engine/faultSim.js';
import { nextUuidv7 } from '../ids/uuidv7.js';
import { extractActor } from '../identity/actorExtractor.js';
import { getIdempotencyStore } from '../idempotency/store.js';
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

    // 6. Extract actor from forwarded Authorization header.
    const actor = extractActor(fwd.headers['authorization']) ?? undefined;

    // 7. Extract sequenceVersion from forwarded If-Match header.
    const ifMatchValue = fwd.headers['if-match'];
    const sequenceVersion = ifMatchValue !== undefined
      ? Number(String(ifMatchValue).replace(/^"|"$/g, ''))
      : undefined;

    // 8. Extract fault signal from forwarded x-specmatic-fault header (already handled above,
    //    but the Command also carries faultSignal for the UoW fault-sim path).
    const faultHeaderRaw = fwd.headers['x-specmatic-fault'];

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
    const idempotencyKey = fwd.headers['idempotency-key'];
    const idempotencyCfg = sys.dsl.idempotency;
    const idempotencyEnabled = idempotencyCfg?.enabled ?? false;

    if (idempotencyEnabled && idempotencyKey && intent !== 'query') {
      const store = getIdempotencyStore();
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
        }),
      );
    } catch (err) {
      logger.error({ err }, 'UoW execution error in forwarding handler');
      const mapped = mapErrorToStatus(err);
      const fwdResponse: ForwardedResponse = {
        status: mapped.status,
        headers: mapped.headers ?? {},
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
      const store = getIdempotencyStore();
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

    const fwdResponse: ForwardedResponse = {
      status: result.status,
      headers: responseHeaders,
      body: result.body,
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
