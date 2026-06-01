/**
 * Admin Routes — out-of-band control and diagnostic endpoints (design §3.2, reqs 37-39)
 *
 * Endpoints:
 *  POST /_admin/reset  — deterministic system reset to post-boot baseline state; 204 No Content.
 *  GET  /_admin/state  — dump full state graph as { entities: { [targetId]: JsonObject } };
 *                        supports ?boundary=X filter (restricts to that boundary; 404 if unknown).
 *  GET  /_admin/events — list all events; supports ?aggregateId=X and ?type=X
 *                        filters, ?count=true (returns { count: N }),
 *                        ?limit=N and ?offset=M pagination.
 *  GET  /_admin/health — liveness/readiness probe; includes version and checks array.
 *
 * Authentication (H-8):
 *  If ADMIN_TOKEN env var is set, all admin routes require an
 *  "Authorization: Bearer <token>" header — returns 401 if missing or wrong.
 *  If ADMIN_TOKEN is not set, open access (current default behaviour).
 *
 * Each route is wrapped in withSpan for distributed-trace visibility.
 */

import type { Express, Request, Response, NextFunction } from 'express';
import type { BootedSystem } from '../engine/boot.js';
import { resetSystem } from '../engine/reset.js';
import { withSpan } from '../observability/tracing.js';
import { getDerivedProjection } from '../projections/engine.js';
import type { FaultRule } from '../dsl/types.js';
import type { DomainEvent } from '../types.js';

// Read package.json version at module load time.
let _pkgVersion = 'unknown';
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pkg = require('../../package.json') as { version: string };
  _pkgVersion = pkg.version;
} catch {
  // Fallback: version stays 'unknown'
}

/**
 * Middleware factory: if ADMIN_TOKEN is configured, enforce Bearer auth on admin routes.
 */
function adminAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = process.env['ADMIN_TOKEN'];
  if (!token) {
    // Open access — ADMIN_TOKEN not configured
    next();
    return;
  }
  const authHeader = req.headers['authorization'] ?? '';
  const expected = `Bearer ${token}`;
  if (authHeader !== expected) {
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'Admin token required' });
    return;
  }
  next();
}

/**
 * Register out-of-band admin/control endpoints on the Express app.
 *
 * Endpoints:
 *  - POST /_admin/reset  — trigger resetSystem; returns 204 No Content.
 *  - GET  /_admin/state  — return all state-graph entries as JSON object.
 *  - GET  /_admin/events — return all events from the EventStore as JSON array.
 *  - GET  /_admin/health — liveness probe with uptime and size metrics.
 */
export function registerAdminRoutes(app: Express, sys: BootedSystem): void {
  // POST /_admin/reset — revert state and events to frozen baseline (req 37).
  app.post(
    '/_admin/reset',
    adminAuthMiddleware,
    (req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.admin.reset', async () => {
        sys.logger.info({ path: req.path }, 'Admin reset triggered');
        resetSystem(sys);
        // Clear any live sessions and restore the virtual clock so a reset
        // returns the system to a fully clean post-boot state.
        sys.sessionStore.reset();
        sys.cel.setClockOffset(0);
        res.status(204).end();
      }).catch(next);
    },
  );

  // POST /_admin/clock/advance — advance the virtual clock by { ms } so tests
  // can deterministically cross TTL boundaries (session expiry, etc.).
  app.post(
    '/_admin/clock/advance',
    adminAuthMiddleware,
    (req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.admin.clock.advance', async () => {
        const body = (req.body ?? {}) as { ms?: unknown };
        const ms = typeof body.ms === 'number' && Number.isFinite(body.ms) ? body.ms : 0;
        const offset = sys.cel.getClockOffset() + ms;
        sys.cel.setClockOffset(offset);
        res.status(200).json({ offsetMs: offset });
      }).catch(next);
    },
  );

  // POST /_admin/clock/reset — restore the virtual clock to real time.
  app.post(
    '/_admin/clock/reset',
    adminAuthMiddleware,
    (req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.admin.clock.reset', async () => {
        sys.cel.setClockOffset(0);
        res.status(200).json({ offsetMs: 0 });
      }).catch(next);
    },
  );

  // GET /_admin/state — diagnostic dump of the full entity state graph (req 38).
  // ?boundary=X filter: restrict the dump to entities originating in that boundary.
  // An entity's boundary is inferred from its first event (same strategy as the
  // collection-query engine), so 404 if no entity belongs to the requested boundary.
  app.get(
    '/_admin/state',
    adminAuthMiddleware,
    (req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.admin.state', async () => {
        const boundaryParam = req.query['boundary'];
        if (boundaryParam !== undefined) {
          const boundary = Array.isArray(boundaryParam) ? boundaryParam[0] : boundaryParam;
          const filtered = sys.graph
            .entries()
            .filter(([targetId]) => {
              const entityEvents = sys.events.byAggregate(targetId);
              return entityEvents.length > 0 && entityEvents[0].boundary === boundary;
            });
          if (filtered.length === 0) {
            res.status(404).json({
              error: 'NOT_FOUND',
              message: `No entities found for boundary "${boundary as string}"`,
            });
            return;
          }
          res.status(200).json({ entities: Object.fromEntries(filtered) });
          return;
        }
        const entities = Object.fromEntries(sys.graph.entries());
        res.status(200).json({ entities });
      }).catch(next);
    },
  );

  // GET /_admin/events — list all events; optional ?aggregateId=X filter (req 39).
  // ?type=<eventType> filters to events of that type (combinable with ?aggregateId).
  // ?count=true returns { count: N } instead of the event array.
  // Supports ?limit=N and ?offset=M for pagination (H-6).
  app.get(
    '/_admin/events',
    adminAuthMiddleware,
    (req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.admin.events', async () => {
        const aggregateId = req.query['aggregateId'];
        let events: readonly DomainEvent[] =
          typeof aggregateId === 'string' && aggregateId.length > 0
            ? sys.events.byAggregate(aggregateId)
            : sys.events.all();

        const type = req.query['type'];
        if (typeof type === 'string' && type.length > 0) {
          events = events.filter(e => e.type === type);
        }

        // ?count=true — return a count payload rather than the events themselves.
        if (req.query['count'] === 'true') {
          res.status(200).json({ count: events.length });
          return;
        }

        // Pagination: ?offset=M&limit=N (H-6)
        const offsetRaw = req.query['offset'];
        const limitRaw = req.query['limit'];
        const offset = typeof offsetRaw === 'string' ? Math.max(0, parseInt(offsetRaw, 10) || 0) : 0;
        const limit = typeof limitRaw === 'string' ? Math.max(1, parseInt(limitRaw, 10) || events.length) : events.length;
        events = events.slice(offset, offset + limit);

        res.status(200).json({ events });
      }).catch(next);
    },
  );

  // GET /_admin/derived/:name — derived projection state (REQ-90).
  app.get(
    '/_admin/derived/:name',
    adminAuthMiddleware,
    (req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.admin.derived', async () => {
        const name = Array.isArray(req.params['name']) ? req.params['name'][0] : req.params['name'];
        const result = getDerivedProjection(sys.derivedProjections, name as string);
        if (result === null) {
          res.status(404).json({ error: 'NOT_FOUND', message: `No derived projection named "${name}"` });
          return;
        }
        res.status(200).json(result);
      }).catch(next);
    },
  );

  // POST /_admin/faults — register a dynamic fault rule. Body is a FaultRule
  // ({ name, match, response, delay_ms?, ttlMs?, expiresAt? }).
  // Optional TTL: ttlMs (milliseconds) or expiresAt (epoch ms). Returns 201 with { id, name }.
  app.post(
    '/_admin/faults',
    adminAuthMiddleware,
    (req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.admin.faults.add', async () => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const rule = body as unknown as FaultRule;
        if (
          typeof rule !== 'object' ||
          rule === null ||
          typeof rule.match !== 'object' ||
          rule.match === null ||
          typeof rule.response !== 'object' ||
          rule.response === null
        ) {
          res.status(400).json({
            error: 'INVALID_FAULT_RULE',
            message: 'A fault rule requires `match` and `response` objects',
          });
          return;
        }
        // Optional TTL: ttlMs (duration) takes precedence over expiresAt (epoch).
        let ttlSeconds: number | undefined;
        if (typeof body['ttlMs'] === 'number' && body['ttlMs'] > 0) {
          ttlSeconds = body['ttlMs'] / 1000;
        } else if (typeof body['expiresAt'] === 'number' && body['expiresAt'] > Date.now()) {
          ttlSeconds = (body['expiresAt'] - Date.now()) / 1000;
        }
        const id = sys.faultStore.add(rule, ttlSeconds);
        sys.logger.info({ faultId: id, name: rule.name, ttlSeconds }, 'Admin: dynamic fault rule registered');
        res.status(201).json({ id, name: rule.name, ...(ttlSeconds !== undefined ? { ttlSeconds } : {}) });
      }).catch(next);
    },
  );

  // GET /_admin/faults — list active dynamic fault rules as [{ id, rule }].
  app.get(
    '/_admin/faults',
    adminAuthMiddleware,
    (_req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.admin.faults.list', async () => {
        const entries = sys.faultStore.list().map(e => ({ id: e.id, rule: e.rule }));
        res.status(200).json(entries);
      }).catch(next);
    },
  );

  // DELETE /_admin/faults/:id — remove a dynamic fault rule; 204 on success,
  // 404 when the id is unknown.
  app.delete(
    '/_admin/faults/:id',
    adminAuthMiddleware,
    (req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.admin.faults.remove', async () => {
        const id = Array.isArray(req.params['id']) ? req.params['id'][0] : req.params['id'];
        const removed = sys.faultStore.remove(id as string);
        if (!removed) {
          res.status(404).json({ error: 'NOT_FOUND', message: `No fault rule with id "${id}"` });
          return;
        }
        res.status(204).end();
      }).catch(next);
    },
  );

  // GET /_admin/health — liveness probe (req 40).
  // Includes version (from package.json) and checks array (H-7).
  app.get(
    '/_admin/health',
    adminAuthMiddleware,
    (_req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.admin.health', async () => {
        res.status(200).json({
          status: 'ok',
          version: _pkgVersion,
          uptime: process.uptime(),
          entityCount: sys.graph.size(),
          eventCount: sys.events.size(),
          checks: [
            { name: 'eventStore', status: 'ok' },
            { name: 'stateGraph', status: 'ok' },
            { name: 'dsl', status: 'ok' },
          ],
        });
      }).catch(next);
    },
  );
}
