import * as yaml from 'js-yaml';
import { BootError } from '../errors.js';
import { createLogger, getTracer, withSpan } from '../observability/index.js';
import { validateBoundaryConfig, validateGlobalConfig } from './schema.js';
import type { BoundaryConfig, CompiledDsl, SagaConfig, IdempotencyConfig, DerivedProjectionConfig } from './types.js';
import { buildScriptRegistry } from '../scripts/registry.js';

const log = createLogger({ name: 'dsl' });

/**
 * Parse a single YAML module string into a BoundaryConfig.
 * Delegates shape validation to `validateBoundaryConfig`.
 * @throws {BootError} with code `BOOT_ERR_DSL_SYNTAX` on parse or validation failure.
 */
export function parseDslYaml(text: string): BoundaryConfig {
  let raw: unknown;
  try {
    raw = yaml.load(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      `YAML parse error: ${message}`,
      { message, source: text.slice(0, 200) },
    );
  }

  return validateBoundaryConfig(raw);
}

/**
 * Compile multiple named YAML modules into a unified, indexed CompiledDsl.
 * REQ-68: Also builds the script registry from all declared scripts.
 *
 * Accepts an optional `globalYaml` string that can declare top-level Tier-2 fields:
 *   sagas, idempotency, derived_projections.  When absent these are omitted.
 *
 * @throws {BootError} with code `BOOT_ERR_DSL_SYNTAX` on any parse or validation failure.
 * @throws {BootError} with code `BOOT_ERR_DSL_DUPLICATE_BOUNDARY` on duplicate boundary names
 *   or contract paths.
 * @throws {BootError} with code `BOOT_ERR_SCRIPT_SYNTAX` on transpilation failure.
 */
export async function compileDsl(
  modules: readonly { name: string; yaml: string }[],
  globalYaml?: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _scriptsDir?: string,
): Promise<CompiledDsl> {
  return withSpan(getTracer('dsl'), 'dsl.compile', (_span) => {
    log.info({ moduleCount: modules.length }, 'Compiling DSL modules');

    const boundaries: BoundaryConfig[] = [];
    const byContractPath: Record<string, BoundaryConfig> = {};
    const byBoundaryName: Record<string, BoundaryConfig> = {};

    for (const mod of modules) {
      const config = parseDslYaml(mod.yaml);

      // Detect duplicate boundary names
      if (Object.prototype.hasOwnProperty.call(byBoundaryName, config.boundary)) {
        throw new BootError(
          'BOOT_ERR_DSL_DUPLICATE_BOUNDARY',
          `Duplicate boundary name "${config.boundary}" found in module "${mod.name}"`,
          { boundary: config.boundary, module: mod.name },
        );
      }

      // Detect duplicate contractPath mappings
      if (Object.prototype.hasOwnProperty.call(byContractPath, config.contractPath)) {
        throw new BootError(
          'BOOT_ERR_DSL_DUPLICATE_BOUNDARY',
          `Duplicate contract_path "${config.contractPath}" found in module "${mod.name}" (boundary "${config.boundary}")`,
          {
            contractPath: config.contractPath,
            boundary: config.boundary,
            module: mod.name,
          },
        );
      }

      boundaries.push(config);
      byBoundaryName[config.boundary] = config;
      byContractPath[config.contractPath] = config;

      log.debug(
        {
          boundary: config.boundary,
          contractPath: config.contractPath,
          behaviorsCount: config.behaviors.length,
          reducersCount: config.reducers.length,
        },
        'Registered boundary',
      );
    }

    log.info(
      { boundaryCount: boundaries.length },
      'DSL compilation complete',
    );

    // ── Tier-2: parse optional global config ───────────────────────────────────
    let sagas: readonly SagaConfig[] | undefined;
    let idempotency: IdempotencyConfig | undefined;
    let derivedProjections: readonly DerivedProjectionConfig[] | undefined;
    let auth: import('./types.js').AuthConfig | undefined;

    if (globalYaml) {
      let rawGlobal: unknown;
      try {
        rawGlobal = yaml.load(globalYaml);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new BootError(
          'BOOT_ERR_DSL_SYNTAX',
          `Global config YAML parse error: ${message}`,
          { message, source: globalYaml.slice(0, 200) },
        );
      }
      const globalConfig = validateGlobalConfig(rawGlobal);
      sagas = globalConfig.sagas;
      idempotency = globalConfig.idempotency;
      derivedProjections = globalConfig.derivedProjections;
      auth = globalConfig.auth;
    }

    const partialDsl: Omit<CompiledDsl, 'scriptRegistry'> = {
      boundaries: boundaries as readonly BoundaryConfig[],
      byContractPath,
      byBoundaryName,
      ...(sagas !== undefined ? { sagas } : {}),
      ...(idempotency !== undefined ? { idempotency } : {}),
      ...(derivedProjections !== undefined ? { derivedProjections } : {}),
      ...(auth !== undefined ? { auth } : {}),
    };

    // REQ-68: Build script registry — transpiles all TS scripts at compile time.
    // Only build if any boundary has scripts.
    const hasScripts = boundaries.some(b => b.scripts && b.scripts.length > 0);
    if (hasScripts) {
      const scriptRegistry = buildScriptRegistry(partialDsl as CompiledDsl, log);
      return { ...partialDsl, scriptRegistry };
    }

    return partialDsl as CompiledDsl;
  });
}
