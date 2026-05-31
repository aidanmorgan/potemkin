/**
 * Acceptance test helper: builds a BootedSystem from the CRM fixture
 * and wraps it in an Express gateway, returning a supertest-compatible agent.
 *
 * Usage:
 *   const { agent, sys, teardown } = await createTestApp();
 *   await agent.post('/leads').send({ companyName: 'Foo', ... }).expect(201);
 *   teardown();
 */

import type { BootedSystem } from '../../../src/engine/boot.js';
import { bootSystem } from '../../../src/engine/boot.js';
import { resetSystem } from '../../../src/engine/reset.js';
import { createGateway } from '../../../src/http/gateway.js';
import { loadFixture } from '../../fixtures/index.js';
import type { BoundaryConfig } from '../../../src/dsl/types.js';
import {
  withPersistentServer,
  type PersistentAgent,
} from '../../_support/persistentAgent.js';
import { registerFileTeardown } from '../../_support/testTeardown.js';

export interface TestApp {
  readonly agent: PersistentAgent;
  readonly sys: BootedSystem;
  reset(): void;
}

/**
 * Expand byContractPath to include all OpenAPI paths, mapping each sub-path
 * to the boundary that owns the base path.
 *
 * The CRM DSL registers 5 base paths (e.g. /leads, /campaigns).
 * The OpenAPI spec declares 23 paths (sub-paths like /leads/{id}/contact).
 * The gateway registers Express routes only for byContractPath keys, so
 * sub-paths need explicit entries pointing to the correct boundary.
 *
 * Sub-paths (e.g. /leads/{id}/contact) must use a boundary variant WITHOUT
 * identity.creation, so POST requests on sub-paths are treated as mutations
 * rather than creations. This prevents 409 EntityConflictError when applying
 * state transitions on existing entities.
 */
function expandByContractPath(sys: BootedSystem): void {
  const byContractPath = sys.dsl.byContractPath as Record<string, BoundaryConfig>;
  const allPaths = Object.keys(sys.openapi.paths);

  for (const openApiPath of allPaths) {
    if (Object.prototype.hasOwnProperty.call(byContractPath, openApiPath)) {
      // Already registered (the base path itself)
      continue;
    }

    // Find the longest registered base path that is a prefix of this OpenAPI path
    let bestBase: string | null = null;
    for (const base of Object.keys(byContractPath)) {
      if (openApiPath.startsWith(base + '/') || openApiPath === base) {
        if (bestBase === null || base.length > bestBase.length) {
          bestBase = base;
        }
      }
    }

    if (bestBase !== null) {
      const baseBoundary = byContractPath[bestBase]!;
      // Create a sub-path boundary variant without identity.creation.
      // This ensures POST on /leads/{id}/contact is treated as mutation,
      // not creation, preventing EntityConflictError (409).
      const subPathBoundary: BoundaryConfig = {
        ...baseBoundary,
        contractPath: openApiPath,
        identity: baseBoundary.identity
          ? { ...baseBoundary.identity, creation: undefined }
          : undefined,
      };
      byContractPath[openApiPath] = subPathBoundary;
    }
  }
}

/**
 * Create a booted gateway app backed by the CRM fixture.
 * Call `app.reset()` between tests to revert to the post-boot baseline.
 */
export async function createTestApp(): Promise<TestApp> {
  const fixture = await loadFixture();
  const sys = await bootSystem(fixture);

  // Expand byContractPath so the gateway registers Express routes for all
  // CRM sub-paths (e.g. /leads/{id}, /leads/{id}/contact, etc.)
  expandByContractPath(sys);

  const app = createGateway(sys);

  // Boot ONE persistent server for this suite, driven by a pooled keep-alive
  // agent, instead of supertest's per-call ephemeral app.listen(0). The server
  // is closed in afterAll via the file-scoped teardown registry.
  const { agent, close } = await withPersistentServer(app);
  registerFileTeardown(close);

  return {
    agent,
    sys,
    reset() {
      resetSystem(sys);
    },
  };
}
