/**
 * Admin Routes — out-of-band control and diagnostic endpoints (design §3.2, reqs 37-39)
 *
 * Endpoints:
 *  POST /_admin/reset  — deterministic system reset to post-boot baseline state; 204 No Content.
 *  GET  /_admin/state  — dump full state graph as { entities: { [targetId]: JsonObject } }.
 *  GET  /_admin/events — list all events; supports ?aggregateId=X filter.
 *  GET  /_admin/health — liveness/readiness probe with uptime and entity/event counts.
 *
 * Each route is wrapped in withSpan for distributed-trace visibility.
 */

import type { Express, Request, Response, NextFunction } from 'express';
import type { BootedSystem } from '../engine/boot.js';
import { resetSystem } from '../engine/reset.js';
import { withSpan } from '../observability/tracing.js';

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
    (req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.admin.reset', async () => {
        sys.logger.info({ path: req.path }, 'Admin reset triggered');
        resetSystem(sys);
        res.status(204).end();
      }).catch(next);
    },
  );

  // GET /_admin/state — diagnostic dump of the full entity state graph (req 38).
  app.get(
    '/_admin/state',
    (req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.admin.state', async () => {
        const entities = Object.fromEntries(sys.graph.entries());
        res.status(200).json({ entities });
      }).catch(next);
    },
  );

  // GET /_admin/events — list all events; optional ?aggregateId=X filter (req 39).
  app.get(
    '/_admin/events',
    (req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.admin.events', async () => {
        const aggregateId = req.query['aggregateId'];
        const events =
          typeof aggregateId === 'string' && aggregateId.length > 0
            ? sys.events.byAggregate(aggregateId)
            : sys.events.all();
        res.status(200).json({ events });
      }).catch(next);
    },
  );

  // GET /_admin/health — liveness probe (req 40).
  app.get(
    '/_admin/health',
    (req: Request, res: Response, next: NextFunction) => {
      withSpan(sys.tracer, 'http.admin.health', async () => {
        res.status(200).json({
          status: 'ok',
          uptime: process.uptime(),
          entityCount: sys.graph.size(),
          eventCount: sys.events.size(),
        });
      }).catch(next);
    },
  );
}
