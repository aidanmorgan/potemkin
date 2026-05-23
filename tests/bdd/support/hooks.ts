import { Before, After } from '@cucumber/cucumber';
import type { SimWorld } from './world.js';

/**
 * Reset per-scenario state before each scenario.
 *
 * If a booted system was loaded in a previous scenario (e.g. via a Background
 * step in the same feature), its in-memory state is stale; this hook clears
 * references so the next scenario starts clean.
 *
 * Full system boot (if needed) is left to scenario-specific step definitions
 * or a feature-level Background block.
 */
Before(function (this: SimWorld) {
  this.lastResponse = undefined;
  this.ctx = {};
  // Note: bootedSystem is intentionally NOT cleared here — some features share
  // a single booted system across scenarios for performance.  Features that
  // require isolation should assign a fresh BootedSystem in their own steps.
});

/**
 * Tear-down hook — currently a no-op; added for future cleanup (e.g. port
 * release, OTel flush) once the HTTP gateway is live.
 */
After(function (this: SimWorld) {
  // no-op
});
