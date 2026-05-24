/**
 * Barrel export for the forwarding module.
 */

export type { ForwardedRequest, ForwardedResponse, RoutesDiscoveryResponse, FixtureStub, FixturesResponse } from './types.js';
export { createForwardingHandler, healthHandler, createRoutesHandler, createFixturesHandler } from './handler.js';
export { deriveFixtures } from './fixtures.js';
