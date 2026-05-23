/**
 * HTTP Gateway — Contract-aware ingestion pipeline (design §2.1, §4.1)
 *
 * Pipeline per inbound request:
 *  1. Fault-signal check (x-specmatic-fault header) — short-circuit before any state access.
 *  2. Contract-route lookup (matchRoute) — 404 if no OpenAPI path matches, 405 if method unknown.
 *  3. Request validation (ContractValidator.validateRequest) — 400 CONTRACT_VIOLATION on failure.
 *  4. Identity/intent resolution — translate HTTP method → Intent; derive or generate targetId.
 *  5. Command construction — typed Command built from request data.
 *  6. Unit-of-Work execution (executeUnitOfWork) — full CQRS/ES dispatch with 2PC commit.
 *  7. Error → HTTP status mapping (§3.x error codes to RFC-standard status codes).
 *  8. Response serialisation — status + headers + JSON body + optional ETag.
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
} from '../errors.js';
import type { Command, Intent } from '../types.js';

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
  app.use(express.json({ strict: false, limit: '5mb' }));

  // Admin routes registered first so they always win over dynamic OpenAPI routes.
  registerAdminRoutes(app, sys);

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
  const logger = sys.logger.child({ requestId, method: req.method, path: req.path });

  await withSpan(sys.tracer, 'http.request', async (_span) => {
    // 2. Fault simulation (req 31): check for x-specmatic-fault header first.
    const fault = extractFaultSignal(req.headers as Record<string, string | string[] | undefined>);
    if (fault !== null) {
      sys.metrics.faultsSimulatedTotal.add(1);
      if (fault.headers) {
        res.set(fault.headers);
      }
      res.status(fault.status).json(fault.body);
      return;
    }

    // 3. Lookup matching contract route (method + path).
    const route = matchRoute(sys.openapi, req.method, req.path);
    if (route === null) {
      // The Express route matched the path template but no OpenAPI operation covers this method.
      // Distinguish: did path match but method not → 405; path itself unrecognised → 404.
      // Since we only register routes for known contractPaths, a null here means wrong method.
      res.status(405).json({ error: 'METHOD_NOT_ALLOWED', method: req.method, path: req.path });
      return;
    }

    // 4. Contract validation (req 12, 24).
    try {
      sys.validator.validateRequest(
        req.method,
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

    // 5. Identity resolution & intent translation (reqs 13-14, design §4.1).
    const boundary = sys.dsl.byContractPath[route.contractPath];
    const intent: Intent = translateIntent({ method: req.method, boundary });

    let targetId: string | null = route.pathParams['id'] ?? null;
    if (intent === 'creation' && targetId === null) {
      const genRule = boundary.identity?.creation?.generate;
      if (genRule === '$uuidv7()') {
        targetId = nextUuidv7();
      }
    }

    // 6. Build Command (req 14).
    const command: Command = {
      commandId: nextUuidv7(),
      boundary: boundary.boundary,
      intent,
      targetId,
      payload: (req.body as JsonObject | null | undefined) ?? {},
      queryParams: req.query as Record<string, string | string[]>,
      httpMethod: req.method,
      path: req.path,
      sequenceVersion: req.headers['if-match'] !== undefined
        ? Number(req.headers['if-match'])
        : undefined,
      origin: 'inbound',
      depth: 0,
    };

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
          logger,
          tracer: sys.tracer,
          metrics: sys.metrics,
        }),
      );
    } catch (err) {
      logger.error({ err }, 'UoW execution error');
      // 8. Error → HTTP mapping (reqs 25-32).
      if (err instanceof EntityAbsenceError) {
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
        res.status(err.status).json(err.simulatedBody);
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
      const lastSeq = result.events.at(-1)?.sequenceVersion;
      if (lastSeq !== undefined) {
        responseHeaders['ETag'] = String(lastSeq);
      }
    }

    res.status(result.status).set(responseHeaders).json(result.body);
  }, { 'http.method': req.method, 'http.path': req.path, requestId });
}
