import { buildScriptRegistry, buildCompositeScriptRegistry } from '../../../src/scripts/registry.js';
import { BootError } from '../../../src/errors.js';
import { createLogger } from '../../../src/observability/logger.js';
import type { CompiledDsl, BoundaryConfig } from '../../../src/dsl/types.js';
import type { JsonObject } from '../../../src/types.js';

const logger = createLogger({ name: 'test-registry' });

// BoundaryWithScripts is an escape-hatch type used by these unit tests so that
// buildScriptRegistry's sandbox/transpile machinery can be exercised directly.
// The inline scripts: form was removed from the DSL (B3) — validateBoundaryConfig
// rejects it at boot — but the registry/sandbox/transpile code is retained and
// tested here in isolation.
type BoundaryWithScripts = BoundaryConfig & {
  readonly scripts?: readonly { name: string; code: string }[];
};

function makeDsl(boundaries: BoundaryWithScripts[]): CompiledDsl {
  const byBoundaryName: Record<string, BoundaryConfig> = {};
  const byContractPath: Record<string, BoundaryConfig> = {};
  for (const b of boundaries) {
    byBoundaryName[b.boundary] = b;
    byContractPath[b.contractPath] = b;
  }
  return { boundaries: boundaries as unknown as BoundaryConfig[], byBoundaryName, byContractPath };
}

function makeBasicBoundary(name: string, scripts?: Array<{ name: string; code: string }>): BoundaryWithScripts {
  return {
    boundary: name,
    contractPath: `/${name.toLowerCase()}`,
    fallbackOverride: false,
    behaviors: [],
    reducers: [],
    eventCatalog: [],
    ...(scripts ? { scripts } : {}),
  };
}

describe('buildScriptRegistry', () => {
  it('returns an empty registry when no boundaries have scripts', () => {
    const dsl = makeDsl([makeBasicBoundary('NoBoundary')]);
    const registry = buildScriptRegistry(dsl, logger);
    expect(registry.size()).toBe(0);
    expect(registry.has('NoBoundary', 'anything')).toBe(false);
    expect(registry.get('NoBoundary', 'anything')).toBeUndefined();
  });

  it('registers a script from a boundary', () => {
    const dsl = makeDsl([
      makeBasicBoundary('Loan', [
        {
          name: 'computeRisk',
          code: `export default (ctx) => ctx.state.balance > 1000 ? 'HIGH' : 'LOW';`,
        },
      ]),
    ]);
    const registry = buildScriptRegistry(dsl, logger);
    expect(registry.size()).toBe(1);
    expect(registry.has('Loan', 'computeRisk')).toBe(true);
    const handle = registry.get('Loan', 'computeRisk');
    expect(handle).toBeDefined();
    expect(handle?.name).toBe('computeRisk');
    expect(handle?.boundary).toBe('Loan');
  });

  it('returns undefined for a script in the wrong boundary', () => {
    const dsl = makeDsl([
      makeBasicBoundary('BoundaryA', [
        { name: 'myScript', code: `export default () => 42;` },
      ]),
    ]);
    const registry = buildScriptRegistry(dsl, logger);
    expect(registry.has('BoundaryB', 'myScript')).toBe(false);
    expect(registry.get('BoundaryB', 'myScript')).toBeUndefined();
  });

  it('handles multiple boundaries and multiple scripts', () => {
    const dsl = makeDsl([
      makeBasicBoundary('A', [
        { name: 'script1', code: `export default () => 1;` },
        { name: 'script2', code: `export default () => 2;` },
      ]),
      makeBasicBoundary('B', [
        { name: 'script1', code: `export default () => 'b1';` },
      ]),
    ]);
    const registry = buildScriptRegistry(dsl, logger);
    expect(registry.size()).toBe(3);
    expect(registry.has('A', 'script1')).toBe(true);
    expect(registry.has('A', 'script2')).toBe(true);
    expect(registry.has('B', 'script1')).toBe(true);
    expect(registry.has('A', 'script3')).toBe(false);
  });

  it('throws BootError(BOOT_ERR_SCRIPT_SYNTAX) on syntax error', () => {
    const dsl = makeDsl([
      makeBasicBoundary('Faulty', [
        { name: 'broken', code: `export default function(ctx) { const x = @ }` },
      ]),
    ]);
    expect(() => buildScriptRegistry(dsl, logger)).toThrow(BootError);
    try {
      buildScriptRegistry(dsl, logger);
    } catch (err) {
      expect((err as BootError).code).toBe('BOOT_ERR_SCRIPT_SYNTAX');
    }
  });

  it('registered handle fn is callable and returns correct value', () => {
    const dsl = makeDsl([
      makeBasicBoundary('Loan', [
        { name: 'riskScore', code: `export default (ctx) => ctx.state.amount > 50000 ? 'HIGH' : 'LOW';` },
      ]),
    ]);
    const registry = buildScriptRegistry(dsl, logger);
    const handle = registry.get('Loan', 'riskScore');
    expect(handle).toBeDefined();
    // Call the fn directly
    const mockCtx = {
      command: { commandId: 'x', boundary: 'Loan', intent: 'mutation' as const, targetId: null, payload: {}, queryParams: {}, httpMethod: 'PUT', path: '/', origin: 'inbound' as const, depth: 0 },
      state: { amount: 100000 },
      payload: {},
      helpers: { uuid: () => 'u', now: () => 'n', deepClone: <T>(v: T) => v, deepMerge: (a: JsonObject, b: JsonObject) => ({ ...a, ...b } as JsonObject) },
      logger: logger,
    };
    const result = handle!.fn(mockCtx);
    expect(result).toBe('HIGH');
  });
});

describe('buildCompositeScriptRegistry — inline-vs-scanned precedence (B2)', () => {
  const scanned = [
    { id: 'shared', source: 'class:Shared', fn: () => 'SCANNED' as unknown },
    { id: 'onlyScanned', source: 'class:OnlyScanned', fn: () => 'SCANNED_ONLY' as unknown },
  ];

  it('an inline script shadows a scanned @Script with the same name (inline wins)', () => {
    // Inline registry built from a boundary that declares an inline `shared` script.
    const inline = buildScriptRegistry(
      makeDsl([makeBasicBoundary('B', [{ name: 'shared', code: 'export default () => "INLINE"' }])]),
      logger,
    );
    const composite = buildCompositeScriptRegistry(inline, scanned);
    const handle = composite.get('B', 'shared');
    expect(handle).toBeDefined();
    expect(handle!.source).not.toMatch(/^class:/); // resolved from inline, not the scanned class
  });

  it('falls back to the scanned @Script by global id when there is no inline script', () => {
    const composite = buildCompositeScriptRegistry(undefined, scanned);
    const handle = composite.get('AnyBoundary', 'onlyScanned');
    expect(handle).toBeDefined();
    expect(handle!.source).toBe('class:OnlyScanned');
  });

  it('returns undefined when the id matches neither inline nor scanned', () => {
    const composite = buildCompositeScriptRegistry(undefined, scanned);
    expect(composite.get('B', 'missing')).toBeUndefined();
  });
});
