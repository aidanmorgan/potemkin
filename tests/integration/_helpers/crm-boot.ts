/**
 * CRM boot helper for integration tests.
 *
 * Provides `bootCrmSystem` which boots the CRM fixture and expands
 * `byContractPath` so the gateway registers Express routes for ALL
 * CRM sub-paths (e.g. /leads/{id}, /leads/{id}/contact, etc.).
 *
 * The CRM DSL defines only 5 base contract_paths (one per boundary).
 * The OpenAPI spec declares 21 paths. Without expansion, requests to
 * sub-paths like GET /leads/{id} return 404.
 *
 * This matches the logic in tests/acceptance/_helpers/test-app.ts.
 */

import type { BootedSystem } from '../../../src/engine/boot.js';
import { bootSystem } from '../../../src/engine/boot.js';
import { loadFixture } from '../../fixtures/index.js';
import type { BoundaryConfig } from '../../../src/dsl/types.js';

/**
 * Expand byContractPath to include all OpenAPI paths, mapping each sub-path
 * to the boundary that owns the base path. Sub-paths get a variant of the
 * boundary WITHOUT identity.creation so POST on sub-paths is treated as
 * mutation rather than creation.
 */
export function expandByContractPath(sys: BootedSystem): void {
  const byContractPath = sys.dsl.byContractPath as Record<string, BoundaryConfig>;
  const allPaths = Object.keys(sys.openapi.paths);

  for (const openApiPath of allPaths) {
    if (Object.prototype.hasOwnProperty.call(byContractPath, openApiPath)) {
      continue;
    }

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
 * Boot the CRM fixture and expand byContractPath for all 21 OpenAPI paths.
 */
export async function bootCrmSystem(): Promise<BootedSystem> {
  const fixture = await loadFixture();
  const sys = await bootSystem(fixture);
  expandByContractPath(sys);
  return sys;
}
