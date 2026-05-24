/**
 * Specmatic compatibility routes — /_specmatic/* admin endpoints.
 *
 * Endpoints:
 *  POST   /_specmatic/expectations            — register a dynamic expectation
 *  POST   /_specmatic/expectations/sequenced  — register a sequenced stub (multiple responses)
 *  DELETE /_specmatic/expectations/:id        — remove expectation by id
 *  DELETE /_specmatic/expectations            — clear all expectations
 *  POST   /_specmatic/expectations/clear      — alias for DELETE /_specmatic/expectations
 *  GET    /_specmatic/expectations            — list all expectations
 *  POST   /_specmatic/http-stub               — register transient stub
 *  DELETE /_specmatic/http-stub/:id           — remove stub by id
 *  GET    /_specmatic/state                   — Specmatic-style state endpoint (empty shape)
 *  POST   /_specmatic/state                   — no-op state setter (Specmatic CLI compat)
 *  GET    /_specmatic/health                  — Specmatic-style health endpoint
 *  GET    /actuator/health                    — Spring Boot / Specmatic probe alias
 *
 * All success responses carry X-Specmatic-Result: success.
 * All error responses carry X-Specmatic-Result: failure.
 *
 * Body format for POST endpoints (Specmatic wire format):
 *   { "http-request": { "method": "...", "path": "...", ... },
 *     "http-response": { "status": 200, "body": ..., "headers": {...} } }
 *
 * Sequenced stub format:
 *   { "http-request": {...}, "http-responses": [resp1, resp2, ...] }
 */

import type { Express, Request, Response, NextFunction } from 'express';
import type { BootedSystem } from '../engine/boot.js';
import { withSpan } from '../observability/tracing.js';
import { childLogger } from '../observability/logger.js';
import type { JsonValue } from '../types.js';
import type { ExpectationRequest, ExpectationResponse } from '../specmatic/types.js';

/** Apply X-Specmatic-Result header then send JSON. */
function sendSuccess(res: Response, status: number, body: unknown): void {
  res.setHeader('X-Specmatic-Result', 'success');
  res.status(status).json(body);
}

function sendFailure(res: Response, status: number, body: unknown): void {
  res.setHeader('X-Specmatic-Result', 'failure');
  res.status(status).json(body);
}

/**
 * Parse the Specmatic wire-format body and extract request + response halves.
 * Returns null (with error already sent) if the body is malformed.
 */
function parseStubBody(
  body: unknown,
  res: Response,
): { request: ExpectationRequest; response: ExpectationResponse } | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendFailure(res, 400, { error: 'STUB_BODY_INVALID', message: 'Request body must be a JSON object' });
    return null;
  }

  const record = body as Record<string, unknown>;
  const rawReq = record['http-request'];
  const rawRes = record['http-response'];

  if (!rawReq || typeof rawReq !== 'object' || Array.isArray(rawReq)) {
    sendFailure(res, 400, { error: 'STUB_BODY_INVALID', message: 'Missing or invalid "http-request" field' });
    return null;
  }
  if (!rawRes || typeof rawRes !== 'object' || Array.isArray(rawRes)) {
    sendFailure(res, 400, { error: 'STUB_BODY_INVALID', message: 'Missing or invalid "http-response" field' });
    return null;
  }

  const reqObj = rawReq as Record<string, unknown>;
  const resObj = rawRes as Record<string, unknown>;

  if (typeof reqObj['method'] !== 'string') {
    sendFailure(res, 400, { error: 'STUB_BODY_INVALID', message: '"http-request.method" must be a string' });
    return null;
  }
  if (typeof reqObj['path'] !== 'string') {
    sendFailure(res, 400, { error: 'STUB_BODY_INVALID', message: '"http-request.path" must be a string' });
    return null;
  }
  if (typeof resObj['status'] !== 'number') {
    sendFailure(res, 400, { error: 'STUB_BODY_INVALID', message: '"http-response.status" must be a number' });
    return null;
  }

  const request: ExpectationRequest = {
    method: reqObj['method'] as string,
    path: reqObj['path'] as string,
    headers: isStringRecord(reqObj['headers'])
      ? (reqObj['headers'] as Record<string, string>)
      : undefined,
    queryParameters: isStringOrArrayRecord(reqObj['query'])
      ? (reqObj['query'] as Record<string, string | string[]>)
      : undefined,
    body: reqObj['body'] !== undefined ? (reqObj['body'] as JsonValue) : undefined,
  };

  const response: ExpectationResponse = {
    status: resObj['status'] as number,
    headers: isStringRecord(resObj['headers'])
      ? (resObj['headers'] as Record<string, string>)
      : undefined,
    body: resObj['body'] !== undefined ? (resObj['body'] as JsonValue) : undefined,
  };

  return { request, response };
}

function isStringRecord(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string');
}

function isStringOrArrayRecord(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(
    (x) => typeof x === 'string' || (Array.isArray(x) && x.every((e) => typeof e === 'string')),
  );
}

/**
 * Optionally validate the stub response body against the OpenAPI contract for its path.
 * Returns true if valid or if no matching route / schema is found (contract-coverage is
 * best-effort for dynamic expectations — Specmatic allows stubs that go beyond the spec).
 *
 * Returns false and sends 400 if the response body fails schema validation.
 */
function validateStubResponseContract(
  request: ExpectationRequest,
  response: ExpectationResponse,
  sys: BootedSystem,
  res: Response,
): boolean {
  // Only validate if there's a body to check
  if (response.body === undefined) return true;

  try {
    sys.validator.validateResponse(
      request.method,
      request.path,
      response.status,
      response.body,
    );
    return true;
  } catch {
    // validateResponse throws InternalExecutionError; treat as contract violation for stubs
    sendFailure(res, 400, {
      error: 'STUB_VALIDATION_FAILED',
      message: `Stub response body does not conform to the OpenAPI contract for ${request.method} ${request.path} → ${response.status}`,
    });
    return false;
  }
}

/**
 * Register all /_specmatic/* routes plus /actuator/health on the given Express app.
 * Must be called BEFORE the CQRS dispatcher routes.
 */
export function registerSpecmaticRoutes(app: Express, sys: BootedSystem): void {
  const specLog = childLogger(sys.logger, { name: 'specmatic' });

  // ── POST /_specmatic/expectations/sequenced ────────────────────────────────
  // Must be registered BEFORE /_specmatic/expectations to avoid route shadowing.
  app.post(
    '/_specmatic/expectations/sequenced',
    (req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.specmatic.add_sequenced', async () => {
        const body = req.body as unknown;
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          sendFailure(res, 400, { error: 'STUB_BODY_INVALID', message: 'Request body must be a JSON object' });
          return;
        }

        const record = body as Record<string, unknown>;
        const rawReq = record['http-request'];
        const rawResponses = record['http-responses'];

        if (!rawReq || typeof rawReq !== 'object' || Array.isArray(rawReq)) {
          sendFailure(res, 400, { error: 'STUB_BODY_INVALID', message: 'Missing or invalid "http-request" field' });
          return;
        }
        if (!Array.isArray(rawResponses) || rawResponses.length === 0) {
          sendFailure(res, 400, { error: 'STUB_BODY_INVALID', message: '"http-responses" must be a non-empty array' });
          return;
        }

        const reqObj = rawReq as Record<string, unknown>;
        if (typeof reqObj['method'] !== 'string') {
          sendFailure(res, 400, { error: 'STUB_BODY_INVALID', message: '"http-request.method" must be a string' });
          return;
        }
        if (typeof reqObj['path'] !== 'string') {
          sendFailure(res, 400, { error: 'STUB_BODY_INVALID', message: '"http-request.path" must be a string' });
          return;
        }

        const responses: ExpectationResponse[] = [];
        for (let i = 0; i < rawResponses.length; i++) {
          const r = rawResponses[i] as unknown;
          if (typeof r !== 'object' || r === null || Array.isArray(r)) {
            sendFailure(res, 400, { error: 'STUB_BODY_INVALID', message: `"http-responses[${i}]" must be an object` });
            return;
          }
          const rObj = r as Record<string, unknown>;
          if (typeof rObj['status'] !== 'number') {
            sendFailure(res, 400, { error: 'STUB_BODY_INVALID', message: `"http-responses[${i}].status" must be a number` });
            return;
          }
          responses.push({
            status: rObj['status'] as number,
            headers: isStringRecord(rObj['headers']) ? (rObj['headers'] as Record<string, string>) : undefined,
            body: rObj['body'] !== undefined ? (rObj['body'] as JsonValue) : undefined,
          });
        }

        const request: ExpectationRequest = {
          method: reqObj['method'] as string,
          path: reqObj['path'] as string,
          headers: isStringRecord(reqObj['headers']) ? (reqObj['headers'] as Record<string, string>) : undefined,
          queryParameters: isStringOrArrayRecord(reqObj['query'])
            ? (reqObj['query'] as Record<string, string | string[]>)
            : undefined,
          body: reqObj['body'] !== undefined ? (reqObj['body'] as JsonValue) : undefined,
        };

        const expectation = sys.expectations.addSequenced(request, responses, { source: 'dynamic' });

        specLog.info(
          { expectationId: expectation.id, method: request.method, path: request.path, responseCount: responses.length },
          'Sequenced stub added',
        );
        sendSuccess(res, 200, { ...expectation });
      }).catch(next);
    },
  );

  // ── POST /_specmatic/expectations/clear ────────────────────────────────────
  // Alias for DELETE /_specmatic/expectations — some Specmatic clients POST to clear.
  app.post(
    '/_specmatic/expectations/clear',
    (req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.specmatic.clear_expectations_post', async () => {
        const count = sys.expectations.size();
        sys.expectations.clear();
        specLog.info({ cleared: count }, 'All expectations cleared (POST alias)');
        sendSuccess(res, 200, { cleared: count });
      }).catch(next);
    },
  );

  // ── POST /_specmatic/expectations ──────────────────────────────────────────
  app.post(
    '/_specmatic/expectations',
    (req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.specmatic.add_expectation', async () => {
        const parsed = parseStubBody(req.body, res);
        if (!parsed) return;

        const { request, response } = parsed;

        if (!validateStubResponseContract(request, response, sys, res)) return;

        const expectation = sys.expectations.add(request, response, {
          transient: false,
          source: 'dynamic',
        });

        specLog.info({ expectationId: expectation.id, method: request.method, path: request.path }, 'Expectation added');
        sendSuccess(res, 200, { ...expectation });
      }).catch(next);
    },
  );

  // ── DELETE /_specmatic/expectations/:id ────────────────────────────────────
  // Always returns 200, matching Specmatic JVM HttpStub behaviour.
  // Body: { "removed": boolean } — true when an expectation was actually deleted,
  // false when no expectation with that id was found (idempotent / tolerant removal).
  app.delete(
    '/_specmatic/expectations/:id',
    (req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.specmatic.remove_expectation', async () => {
        const id = String(req.params['id'] ?? '');
        const removed = sys.expectations.remove(id);
        if (removed) {
          specLog.info({ expectationId: id }, 'Expectation removed');
        } else {
          specLog.debug({ expectationId: id }, 'Expectation not found for removal (tolerant)');
        }
        sendSuccess(res, 200, { removed });
      }).catch(next);
    },
  );

  // ── DELETE /_specmatic/expectations ────────────────────────────────────────
  app.delete(
    '/_specmatic/expectations',
    (req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.specmatic.clear_expectations', async () => {
        const count = sys.expectations.size();
        sys.expectations.clear();
        specLog.info({ cleared: count }, 'All expectations cleared');
        sendSuccess(res, 200, { cleared: count });
      }).catch(next);
    },
  );

  // ── GET /_specmatic/expectations ───────────────────────────────────────────
  app.get(
    '/_specmatic/expectations',
    (req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.specmatic.list_expectations', async () => {
        const list = sys.expectations.list();
        sendSuccess(res, 200, list);
      }).catch(next);
    },
  );

  // ── POST /_specmatic/http-stub ─────────────────────────────────────────────
  app.post(
    '/_specmatic/http-stub',
    (req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.specmatic.add_http_stub', async () => {
        const parsed = parseStubBody(req.body, res);
        if (!parsed) return;

        const { request, response } = parsed;

        if (!validateStubResponseContract(request, response, sys, res)) return;

        const expectation = sys.expectations.add(request, response, {
          transient: true,
          source: 'dynamic',
        });

        specLog.info({ expectationId: expectation.id, method: request.method, path: request.path }, 'Transient stub added');
        sendSuccess(res, 200, { ...expectation });
      }).catch(next);
    },
  );

  // ── DELETE /_specmatic/http-stub/:id ───────────────────────────────────────
  app.delete(
    '/_specmatic/http-stub/:id',
    (req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.specmatic.remove_http_stub', async () => {
        const id = String(req.params['id'] ?? '');
        // Does not 404 if stub not found (tolerant removal for transient cleanup)
        const removed = sys.expectations.remove(id);
        specLog.info({ expectationId: id, removed }, 'Stub removal attempt');
        sendSuccess(res, 200, { id, removed });
      }).catch(next);
    },
  );

  // ── GET /_specmatic/state ──────────────────────────────────────────────────
  // Specmatic-style state endpoint. Their CLI hits this for Gherkin-style scenario state
  // which we don't support — return the canonical empty shape.
  app.get(
    '/_specmatic/state',
    (_req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.specmatic.get_state', async () => {
        sendSuccess(res, 200, {
          scenarios: [],
          expectations: sys.expectations.size(),
          stubs: sys.expectations.size(),
          state: {},
        });
      }).catch(next);
    },
  );

  // ── POST /_specmatic/state ─────────────────────────────────────────────────
  // No-op state setter. Specmatic CLI posts scenario state here; our CQRS state graph
  // is the real state model so we accept and discard the body per design.
  app.post(
    '/_specmatic/state',
    (_req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.specmatic.set_state', async () => {
        // No-op: accept and discard body.
        sendSuccess(res, 200, { status: 'OK' });
      }).catch(next);
    },
  );

  // ── GET /_specmatic/health ─────────────────────────────────────────────────
  app.get(
    '/_specmatic/health',
    (_req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.specmatic.health', async () => {
        sendSuccess(res, 200, { status: 'UP' });
      }).catch(next);
    },
  );

  // ── GET /actuator/health — Spring Boot / Specmatic probe alias ────────────
  app.get(
    '/actuator/health',
    (_req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.specmatic.actuator_health', async () => {
        sendSuccess(res, 200, { status: 'UP' });
      }).catch(next);
    },
  );
}
