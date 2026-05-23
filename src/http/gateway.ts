import type { BootedSystem } from '../engine/boot.js';

/**
 * Minimal structural type for an Express application.
 * Implementation agents will replace this with `import type { Express } from 'express'`
 * once node_modules are installed.
 */
export interface ExpressApp {
  use(...args: unknown[]): this;
  get(path: string, ...handlers: unknown[]): this;
  post(path: string, ...handlers: unknown[]): this;
  put(path: string, ...handlers: unknown[]): this;
  patch(path: string, ...handlers: unknown[]): this;
  delete(path: string, ...handlers: unknown[]): this;
  listen(port: number, cb?: () => void): unknown;
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
 *  - Dispatch queries to runQuery.
 *  - Register admin routes via registerAdminRoutes.
 *  - Serialise ExecutionResult (or error) to the HTTP response.
 */
export function createGateway(sys: BootedSystem): ExpressApp {
  throw new Error('NotImplemented: http/gateway.createGateway');
}
