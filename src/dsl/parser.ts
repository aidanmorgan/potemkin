import * as yaml from 'js-yaml';
import { BootError } from '../errors.js';
import { createLogger, getTracer, withSpan } from '../observability/index.js';
import { validateBoundaryConfig, validateGlobalConfig } from './schema.js';
import type { AuthConfig, BoundaryConfig, CompiledDsl, FaultRule, HateoasConfig, SagaConfig, IdempotencyConfig, DerivedProjectionConfig, LatencyConfig, SecurityHeadersConfig, VersioningConfig, WebhookConfig } from './types.js';
import { buildScriptRegistry } from '../scripts/registry.js';

const log = createLogger({ name: 'dsl' });

/**
 * Parse an optional per-boundary `latency:` block. Each field is an integer
 * millisecond count; non-numeric or negative values are dropped. Returns
 * undefined when the block is absent or carries no usable field.
 */
function parseLatencyConfig(raw: unknown): LatencyConfig | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const out: { min_ms?: number; max_ms?: number; fixed_ms?: number } = {};
  for (const key of ['min_ms', 'max_ms', 'fixed_ms'] as const) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Parse a single YAML module string into a BoundaryConfig.
 * Delegates shape validation to `validateBoundaryConfig`, then layers on the
 * optional `latency:` block (which `validateBoundaryConfig` does not surface).
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

  const config = validateBoundaryConfig(raw);
  const latency = parseLatencyConfig((raw as Record<string, unknown> | null)?.['latency']);
  return latency !== undefined ? { ...config, latency } : config;
}

/**
 * Compile multiple named YAML modules into a unified, indexed CompiledDsl.
 * Accepts an optional `globalYaml` string that can declare top-level fields
 * (sagas, idempotency, derived_projections). When absent these are omitted.
 *
 * @throws {BootError} with code `BOOT_ERR_DSL_SYNTAX` on any parse or validation failure.
 * @throws {BootError} with code `BOOT_ERR_DSL_DUPLICATE_BOUNDARY` on duplicate boundary names
 *   or contract paths.
 * @throws {BootError} with code `BOOT_ERR_SCRIPT_SYNTAX` on transpilation failure.
 */
export async function compileDsl(
  modules: readonly { name: string; yaml: string }[],
  globalYaml?: string,
): Promise<CompiledDsl> {
  return withSpan(getTracer('dsl'), 'dsl.compile', (_span) => {
    log.info({ moduleCount: modules.length }, 'Compiling DSL modules');

    const boundaries: BoundaryConfig[] = [];
    const byContractPath: Record<string, BoundaryConfig> = {};
    const byBoundaryName: Record<string, BoundaryConfig> = {};

    for (const mod of modules) {
      const config = parseDslYaml(mod.yaml);

        if (Object.prototype.hasOwnProperty.call(byBoundaryName, config.boundary)) {
        throw new BootError(
          'BOOT_ERR_DSL_DUPLICATE_BOUNDARY',
          `Duplicate boundary name "${config.boundary}" found in module "${mod.name}"`,
          { boundary: config.boundary, module: mod.name },
        );
      }

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

    let sagas: readonly SagaConfig[] | undefined;
    let idempotency: IdempotencyConfig | undefined;
    let derivedProjections: readonly DerivedProjectionConfig[] | undefined;
    let auth: AuthConfig | undefined;
    let hateoas: HateoasConfig | undefined;
    let versioning: VersioningConfig | undefined;
    let securityHeaders: SecurityHeadersConfig | undefined;
    let faults: readonly FaultRule[] | undefined;
    let webhooks: readonly WebhookConfig[] | undefined;

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
      hateoas = globalConfig.hateoas;
      versioning = globalConfig.versioning;
      securityHeaders = globalConfig.securityHeaders;
      faults = globalConfig.faults;
      webhooks = globalConfig.webhooks;
    }

    const partialDsl: Omit<CompiledDsl, 'scriptRegistry'> = {
      boundaries: boundaries as readonly BoundaryConfig[],
      byContractPath,
      byBoundaryName,
      ...(sagas !== undefined ? { sagas } : {}),
      ...(idempotency !== undefined ? { idempotency } : {}),
      ...(derivedProjections !== undefined ? { derivedProjections } : {}),
      ...(auth !== undefined ? { auth } : {}),
      ...(hateoas !== undefined ? { hateoas } : {}),
      ...(versioning !== undefined ? { versioning } : {}),
      ...(securityHeaders !== undefined ? { securityHeaders } : {}),
      ...(faults !== undefined ? { faults } : {}),
      ...(webhooks !== undefined ? { webhooks } : {}),
    };

    // Build the script registry only when at least one boundary declares scripts.
    const hasScripts = boundaries.some(b => b.scripts && b.scripts.length > 0);
    if (hasScripts) {
      const scriptRegistry = buildScriptRegistry(partialDsl as CompiledDsl, log);
      return { ...partialDsl, scriptRegistry };
    }

    return partialDsl as CompiledDsl;
  });
}
