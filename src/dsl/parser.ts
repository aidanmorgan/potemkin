import * as yaml from 'js-yaml';
import { BootError } from '../errors.js';
import { createLogger, getTracer, withSpan } from '../observability/index.js';
import { validateBoundaryConfig } from './schema.js';
import type { BoundaryConfig, CompiledDsl } from './types.js';

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
 * @throws {BootError} with code `BOOT_ERR_DSL_SYNTAX` on any parse or validation failure.
 * @throws {BootError} with code `BOOT_ERR_DSL_DUPLICATE_BOUNDARY` on duplicate boundary names
 *   or contract paths.
 */
export async function compileDsl(
  modules: readonly { name: string; yaml: string }[],
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

    return {
      boundaries: boundaries as readonly BoundaryConfig[],
      byContractPath,
      byBoundaryName,
    };
  });
}
