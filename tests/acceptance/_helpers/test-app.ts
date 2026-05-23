/**
 * Acceptance test helper: builds a BootedSystem from the banking fixture
 * and wraps it in an Express gateway, returning a supertest-compatible agent.
 *
 * Usage:
 *   const { agent, sys, teardown } = await createTestApp();
 *   await agent.post('/customers').send({ name: 'Foo', riskBand: 'LOW' }).expect(201);
 *   teardown();
 */

import type { BootedSystem } from '../../../src/engine/boot.js';
import { bootSystem } from '../../../src/engine/boot.js';
import { resetSystem } from '../../../src/engine/reset.js';
import { createGateway } from '../../../src/http/gateway.js';
import { loadBankingFixture } from '../../integration/_helpers/inline-fixture.js';
import request from 'supertest';

export interface TestApp {
  readonly agent: ReturnType<typeof request>;
  readonly sys: BootedSystem;
  reset(): void;
}

/**
 * Create a booted gateway app backed by the banking fixture.
 * Call `app.reset()` between tests to revert to the post-boot baseline.
 */
export async function createTestApp(): Promise<TestApp> {
  const fixture = await loadBankingFixture();
  const sys = await bootSystem(fixture);
  const app = createGateway(sys);

  return {
    agent: request(app),
    sys,
    reset() {
      resetSystem(sys);
    },
  };
}
