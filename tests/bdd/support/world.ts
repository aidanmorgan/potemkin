import { setWorldConstructor, World } from '@cucumber/cucumber';
import type { IWorldOptions } from '@cucumber/cucumber';
import type { BootedSystem } from '../../../src/engine/boot.js';
import type { JsonValue } from '../../../src/types.js';

/**
 * Shared test world for the Specmatic Stateful Simulation Engine BDD suite.
 *
 * Holds the booted system under test and any transient HTTP response captured
 * during scenario execution.  Step definitions access these fields directly.
 */
export class SimWorld extends World {
  /** The fully-booted system under test; populated by a Before hook or step. */
  bootedSystem?: BootedSystem;

  /** The last HTTP-like response returned by the engine (status + body). */
  lastResponse?: {
    status: number;
    body: JsonValue;
    headers?: Record<string, string>;
  };

  /** Arbitrary per-scenario context bag for step defs to store intermediates. */
  ctx: Record<string, unknown> = {};

  constructor(options: IWorldOptions) {
    super(options);
  }
}

setWorldConstructor(SimWorld);
