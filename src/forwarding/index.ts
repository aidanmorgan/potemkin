/**
 * Barrel export for the forwarding module.
 */

export type { ForwardedRequest, ForwardedResponse } from './types.js';
export { createForwardingHandler, healthHandler } from './handler.js';
