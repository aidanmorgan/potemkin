/**
 * Admin Routes — out-of-band control and diagnostic endpoints (design §3.2, reqs 37-39)
 *
 * Endpoints:
 *  POST /_admin/reset  — deterministic system reset to post-boot baseline state; 204 No Content.
 *  GET  /_admin/state  — dump full state graph as { entities: { [targetId]: JsonObject } };
 *                        supports ?boundary=X filter (returns 400 if param sent, future work).
 *  GET  /_admin/events — list all events; supports ?aggregateId=X filter,
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
        res.status(204).end();
      }).catch(next);
    },
  );

  // GET /_admin/state — diagnostic dump of the full entity state graph (req 38).
  // ?boundary=X filter: not yet implemented — returns 400 if the param is supplied.
  // Future work: infer boundary from the last event per aggregate to support filtering.
  app.get(
    '/_admin/state',
    adminAuthMiddleware,
    (req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.admin.state', async () => {
        if (req.query['boundary'] !== undefined) {
          res.status(400).json({
            error: 'NOT_IMPLEMENTED',
            message: '?boundary= filter is not yet implemented — future work',
          });
          return;
        }
        const entities = Object.fromEntries(sys.graph.entries());
        res.status(200).json({ entities });
      }).catch(next);
    },
  );

  // GET /_admin/events — list all events; optional ?aggregateId=X filter (req 39).
  // Supports ?limit=N and ?offset=M for pagination (H-6).
  app.get(
    '/_admin/events',
    adminAuthMiddleware,
    (req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.admin.events', async () => {
        const aggregateId = req.query['aggregateId'];
        let events =
          typeof aggregateId === 'string' && aggregateId.length > 0
            ? sys.events.byAggregate(aggregateId)
            : sys.events.all();

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
