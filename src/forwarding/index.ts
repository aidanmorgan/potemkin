/**
 * Barrel export for the forwarding module.
 */

export type { ForwardedRequest, ForwardedResponse, RoutesDiscoveryResponse } from './types.js';
export { createForwardingHandler, healthHandler, createRoutesHandler } from './handler.js';
