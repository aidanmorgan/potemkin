import type { ExpressApp } from './gateway.js';
import type { BootedSystem } from '../engine/boot.js';

/**
 * Register out-of-band admin/control endpoints on the Express app.
 *
 * Endpoints:
 *  - POST /_admin/reset  — trigger resetSystem; returns 204 No Content.
 *  - GET  /_admin/events — return all events from the EventStore as JSON array.
 *  - GET  /_admin/state  — return all state-graph entries as JSON object.
 */
export function registerAdminRoutes(app: ExpressApp, sys: BootedSystem): void {
  throw new Error('NotImplemented: http/adminRoutes.registerAdminRoutes');
}
