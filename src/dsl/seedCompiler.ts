// Compile a `seeds:` declaration into the response body the plugin will
// push via httpStub.setExpectation. Patches apply on top of a base (the
// Specmatic-generated body when base==='contract', otherwise {}); journal
// entries are tagged source: seed.

import { applyPatches } from './patches.js';
import type { Patch } from './patches.js';
import type { JsonObject, JsonValue } from '../types.js';

export interface SeedRequestMatcher {
  readonly method: string;
  readonly path: string;
}

export interface SeedDeclaration {
  readonly description?: string;
  readonly request: SeedRequestMatcher;
  readonly base: 'contract' | 'empty';
  readonly patches: readonly Patch[];
}

export interface CompiledSeed {
  readonly description?: string;
  readonly request: SeedRequestMatcher;
  /** Response body after applying the seed's patches to the base. */
  readonly body: JsonValue;
  /** Journal so observers can attribute mutations to `source: seed`. */
  readonly journal: ReturnType<typeof applyPatches>['journal'];
}

export interface SeedCompileContext {
  /**
   * Resolve the `contract`-base body for a seed's request matcher. The plugin
   * supplies this — it queries Specmatic for the matching scenario's generated
   * body. When unavailable (e.g. test contexts), pass `() => ({})`.
   */
  resolveContractBase(req: SeedRequestMatcher): JsonObject;
}

export function compileSeed(seed: SeedDeclaration, ctx: SeedCompileContext): CompiledSeed {
  const base: JsonObject = seed.base === 'contract' ? ctx.resolveContractBase(seed.request) : {};
  const result = applyPatches(base, seed.patches, 'seed');
  return {
    ...(seed.description ? { description: seed.description } : {}),
    request: seed.request,
    body: result.newState,
    journal: result.journal,
  };
}

export function compileSeeds(
  seeds: readonly SeedDeclaration[],
  ctx: SeedCompileContext,
): CompiledSeed[] {
  return seeds.map((s) => compileSeed(s, ctx));
}
