/**
 * Booting tests/fixtures/crm via BootInput.potemkinConfigPath produces a
 * CompiledDsl (and post-boot state graph) IDENTICAL to the inline compileDsl
 * path used by loadFixtureWithGlobal.
 *
 * Both paths feed the SAME snake_case modules + global.yaml through the SAME
 * compiler (compileDsl), so the structural DSL and the hydrated baseline state
 * must match byte-for-byte (modulo non-serialisable script handles).
 */

import * as path from 'node:path';

import { bootSystem, type BootedSystem } from '../../src/engine/boot.js';
import { loadFixtureWithGlobal } from '../fixtures/index.js';
import type { CompiledDsl } from '../../src/dsl/types.js';

const CRM_CONFIG = path.join(__dirname, '..', 'fixtures', 'crm', 'potemkin.yaml');

/** loadFixtureWithGlobal always populates compiledDsl; narrow the optional type. */
function requireCompiled(dsl: CompiledDsl | undefined): CompiledDsl {
  if (!dsl) throw new Error('fixture did not produce a compiledDsl');
  return dsl;
}

/**
 * Structural projection of a CompiledDsl with the non-serialisable
 * scriptRegistry stripped. The `boundaries` array is sorted by name so the
 * comparison is insensitive to module insertion order (the on-disk path sees
 * files in sorted-glob order; the inline path uses an explicit list).
 */
function structural(dsl: CompiledDsl): unknown {
  const { scriptRegistry, boundaries, ...rest } = dsl as CompiledDsl & { scriptRegistry?: unknown };
  void scriptRegistry;
  const sortedBoundaries = [...boundaries].sort((a, b) => a.boundary.localeCompare(b.boundary));
  return JSON.parse(JSON.stringify({ ...rest, boundaries: sortedBoundaries }));
}

/** Sorted [id, state] snapshot of the entire state graph. */
function graphSnapshot(sys: BootedSystem): Array<readonly [string, unknown]> {
  return [...sys.graph.entries()]
    .map(([id, state]) => [id, state] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
}

describe('potemkinConfigPath boot equals inline compileDsl boot', () => {
  it('boots the CRM fixture from potemkin.yaml on disk', async () => {
    const inline = await loadFixtureWithGlobal();
    const sys = await bootSystem({
      openapi: inline.openapi,
      potemkinConfigPath: CRM_CONFIG,
    });
    expect(sys.dsl.boundaries.length).toBeGreaterThan(0);
  });

  it('produces an identical structural CompiledDsl vs the inline path', async () => {
    const inline = await loadFixtureWithGlobal();

    const onDisk = await bootSystem({
      openapi: inline.openapi,
      potemkinConfigPath: CRM_CONFIG,
    });
    const inMemory = await bootSystem({
      openapi: inline.openapi,
      compiledDsl: requireCompiled(inline.compiledDsl),
    });

    expect(structural(onDisk.dsl)).toEqual(structural(inMemory.dsl));
  });

  it('hydrates an identical baseline state graph vs the inline path', async () => {
    const inline = await loadFixtureWithGlobal();

    const onDisk = await bootSystem({
      openapi: inline.openapi,
      potemkinConfigPath: CRM_CONFIG,
    });
    const inMemory = await bootSystem({
      openapi: inline.openapi,
      compiledDsl: requireCompiled(inline.compiledDsl),
    });

    expect(graphSnapshot(onDisk)).toEqual(graphSnapshot(inMemory));
  });

  it('carries the same boundary names, sagas, idempotency, and derived projections', async () => {
    const inline = await loadFixtureWithGlobal();
    const onDisk = await bootSystem({
      openapi: inline.openapi,
      potemkinConfigPath: CRM_CONFIG,
    });

    expect(Object.keys(onDisk.dsl.byBoundaryName).sort()).toEqual(
      Object.keys(requireCompiled(inline.compiledDsl).byBoundaryName).sort(),
    );
    expect(onDisk.dsl.idempotency).toEqual(requireCompiled(inline.compiledDsl).idempotency);
    expect(onDisk.dsl.sagas).toEqual(requireCompiled(inline.compiledDsl).sagas);
    expect(onDisk.dsl.derivedProjections).toEqual(requireCompiled(inline.compiledDsl).derivedProjections);
  });

  it('still accepts an in-memory compiledDsl (BootInput.compiledDsl)', async () => {
    const inline = await loadFixtureWithGlobal();
    const sys = await bootSystem({
      openapi: inline.openapi,
      compiledDsl: requireCompiled(inline.compiledDsl),
    });
    expect(sys.dsl.boundaries.length).toBe(requireCompiled(inline.compiledDsl).boundaries.length);
  });
});
