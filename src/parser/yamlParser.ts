import * as yaml from 'js-yaml';
import { BootError } from '../errors.js';
import { createNoopLogger, type Logger } from '../observability/logger.js';
import { createNoopTracer, withSpan, type Tracer } from '../observability/tracing.js';
import {
  validateBoundaryConfig,
  validateComponentConfig,
  validateGlobalConfig,
  validateUseEntries,
} from '../dsl/schema.js';
import type {
  AuthConfig,
  BoundaryConfig,
  YamlLinkedProgram,
  ComponentDefinition,
  FaultRule,
  FallbackConfig,
  HateoasConfig,
  ReactionRule,
  SagaConfig,
  IdempotencyConfig,
  DerivedProjectionConfig,
  LatencyConfig,
  UseEntry,
  VersioningConfig,
  WebhookConfig,
} from '../dsl/types.js';
import type { SecurityHeadersConfig } from '../contracts/response.js';
import { linkComponents, mergeIncludes } from '../dsl/componentLinker.js';
import { buildReactionRegistry, validateReactionCrossReferences } from '../dsl/reactionRegistry.js';
import { boundaryConfigToInferenceInput, buildInferredSchema } from '../dsl/schemaInference.js';

export interface YamlCompilationObservability {
  readonly logger?: Logger;
  readonly tracer?: Tracer;
}

/**
 * Parse an optional per-boundary `latency:` block. Each field is a finite,
 * non-negative millisecond value; malformed values are rejected so YAML does
 * not silently produce a different runtime model from TypeScript. Returns
 * undefined when the block is absent or empty.
 */
export function parseLatencyConfig(raw: unknown): LatencyConfig | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BootError('BOOT_ERR_DSL_SCHEMA_VIOLATION', 'latency must be an object', {
      field: 'latency',
    });
  }
  const obj = raw as Record<string, unknown>;
  const out: { min_ms?: number; max_ms?: number; fixed_ms?: number } = {};
  for (const key of Object.keys(obj)) {
    if (key !== 'min_ms' && key !== 'max_ms' && key !== 'fixed_ms')
      throw new BootError(
        'BOOT_ERR_DSL_SCHEMA_VIOLATION',
        `latency contains unknown field "${key}"`,
        { field: `latency.${key}` },
      );
  }
  for (const key of ['min_ms', 'max_ms', 'fixed_ms'] as const) {
    const v = obj[key];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0))
      throw new BootError(
        'BOOT_ERR_DSL_SCHEMA_VIOLATION',
        `latency.${key} must be a finite non-negative number`,
        { field: `latency.${key}` },
      );
    if (typeof v === 'number') out[key] = v;
  }
  if (out.min_ms !== undefined && out.max_ms !== undefined && out.max_ms < out.min_ms)
    throw new BootError(
      'BOOT_ERR_DSL_SCHEMA_VIOLATION',
      'latency.max_ms must be greater than or equal to latency.min_ms',
      { field: 'latency.max_ms' },
    );
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Parse a single YAML module string into a BoundaryConfig.
 * Delegates shape validation to `validateBoundaryConfig`, then layers on the
 * optional `latency:` block (which `validateBoundaryConfig` does not surface).
 * @throws {BootError} with code `BOOT_ERR_DSL_SYNTAX` on parse or validation failure.
 */
export function parseYaml(text: string): BoundaryConfig {
  let raw: unknown;
  try {
    raw = yaml.load(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `YAML parse error: ${message}`, {
      message,
      source: text.slice(0, 200),
    });
  }

  const config = validateBoundaryConfig(raw);
  const latency = parseLatencyConfig((raw as Record<string, unknown> | null)?.['latency']);
  return latency !== undefined ? { ...config, latency } : config;
}

/**
 * Parse a `kind: component` YAML module into a ComponentDefinition.
 * @throws {BootError} with code `BOOT_ERR_DSL_SYNTAX` on parse or validation failure.
 */
export function parseComponent(text: string): ComponentDefinition {
  let raw: unknown;
  try {
    raw = yaml.load(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `YAML parse error: ${message}`, {
      message,
      source: text.slice(0, 200),
    });
  }
  const config = validateComponentConfig(raw);
  const latency = parseLatencyConfig((raw as Record<string, unknown> | null)?.['latency']);
  return latency !== undefined ? { ...config, latency } : config;
}

/**
 * Parse a use-mapping YAML file (only `use:` key present) into an array of UseEntry.
 * @throws {BootError} with code `BOOT_ERR_DSL_SYNTAX` on parse or validation failure.
 */
export function parseUseMapping(text: string): readonly UseEntry[] {
  let raw: unknown;
  try {
    raw = yaml.load(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BootError('BOOT_ERR_DSL_SYNTAX', `YAML parse error: ${message}`, {
      message,
      source: text.slice(0, 200),
    });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      'Use-mapping file root must be a YAML mapping object',
      { received: typeof raw },
    );
  }
  const rec = raw as Record<string, unknown>;
  const useEntries = validateUseEntries(rec['use'], 'root');
  if (useEntries === undefined || useEntries.length === 0) {
    throw new BootError(
      'BOOT_ERR_DSL_SYNTAX',
      'Use-mapping file must have a non-empty "use" array',
      { field: 'use' },
    );
  }
  return useEntries;
}

/**
 * Link multiple named YAML modules into one parser-owned YAML program.
 * Accepts an optional `globalYaml` string that can declare top-level fields
 * (sagas, idempotency, derived_projections). When absent these are omitted.
 *
 * Component modules (`kind: component`) are parsed into a catalog and stashed
 * on YamlLinkedProgram.components — they produce no live boundaries.
 *
 * Use-mapping modules (files with only a `use:` key) are parsed and stashed
 * on YamlLinkedProgram.use for the C3 linker; they also produce no live boundaries.
 *
 * @throws {BootError} with code `BOOT_ERR_DSL_SYNTAX` on any parse or validation failure.
 * @throws {BootError} with code `BOOT_ERR_DSL_DUPLICATE_BOUNDARY` on duplicate boundary names
 *   or contract paths.
 */
export async function compileYaml(
  modules: readonly { name: string; yaml: string }[],
  globalYaml?: string,
  componentModules?: readonly { name: string; yaml: string }[],
  useMappingModules?: readonly { name: string; yaml: string }[],
  observability: YamlCompilationObservability = {},
): Promise<YamlLinkedProgram> {
  const log = observability.logger ?? createNoopLogger();
  return withSpan(observability.tracer ?? createNoopTracer(), 'dsl.compile', (_span) => {
    log.info({ moduleCount: modules.length }, 'Compiling DSL modules');

    const boundaries: BoundaryConfig[] = [];
    const byContractPath: Record<string, BoundaryConfig> = {};
    const byBoundaryName: Record<string, BoundaryConfig> = {};

    for (const mod of modules) {
      const config = parseYaml(mod.yaml);

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

    log.info({ boundaryCount: boundaries.length }, 'DSL compilation complete');

    // Parse component modules into the catalog.
    const componentsMap: Record<string, ComponentDefinition> = {};
    if (componentModules && componentModules.length > 0) {
      for (const mod of componentModules) {
        const componentDef = parseComponent(mod.yaml);
        if (Object.prototype.hasOwnProperty.call(componentsMap, componentDef.name)) {
          throw new BootError(
            'BOOT_ERR_DSL_DUPLICATE_BOUNDARY',
            `Duplicate component name "${componentDef.name}" found in module "${mod.name}"`,
            { component: componentDef.name, module: mod.name },
          );
        }
        componentsMap[componentDef.name] = componentDef;
        log.debug({ component: componentDef.name }, 'Registered component');
      }
    }

    // Parse use-mapping modules and accumulate their use entries.
    const allUseEntries: UseEntry[] = [];
    if (useMappingModules && useMappingModules.length > 0) {
      for (const mod of useMappingModules) {
        const useEntries = parseUseMapping(mod.yaml);
        allUseEntries.push(...useEntries);
        log.debug(
          { useCount: useEntries.length, module: mod.name },
          'Registered use-mapping entries',
        );
      }
    }

    // C3: Link use: entries into concrete boundaries.
    // Runs after file boundaries are registered and before cross-reference validation,
    // so the merged byBoundaryName is the flat model the rest of compileYaml operates on.
    // The duplicate-name/path guard inside linkComponents covers concrete post-link names
    // in addition to the file-boundary guard applied in the loop above.
    if (allUseEntries.length > 0) {
      const linked = linkComponents(allUseEntries, componentsMap, byBoundaryName, byContractPath);
      boundaries.push(...linked);
      log.info({ linkedCount: linked.length }, 'Linked use: entries into concrete boundaries');
    }

    // C4: Merge include: fragments into their host boundaries.
    // Runs after C3 so that use:-instantiated boundaries (which may carry
    // include: from their component definition) are already in `boundaries`.
    // Boundaries without include: are untouched.
    const hasAnyIncludes = boundaries.some((b) => b.include && b.include.length > 0);
    if (hasAnyIncludes) {
      mergeIncludes(boundaries, componentsMap, byBoundaryName, byContractPath);
      log.info('Merged include: fragments into host boundaries');
    }

    // Validate the declarative state model before lowering it into runtime
    // callbacks. This keeps computed-field dependency errors at the YAML
    // boundary and preserves the documented strict_schema behavior without
    // teaching the source-independent engine about CEL or YAML fields.
    for (const boundary of boundaries) {
      const inferred = buildInferredSchema({
        ...boundaryConfigToInferenceInput(boundary),
        strict: boundary.strictSchema !== false,
      });
      for (const warning of inferred.warnings) {
        log.warn({ boundary: boundary.boundary, warning }, 'Non-strict computed-field dependency');
      }
    }

    let sagas: readonly SagaConfig[] | undefined;
    let idempotency: IdempotencyConfig | undefined;
    let derivedProjections: readonly DerivedProjectionConfig[] | undefined;
    let auth: AuthConfig | undefined;
    let hateoas: HateoasConfig | undefined;
    let versioning: VersioningConfig | undefined;
    let securityHeaders: SecurityHeadersConfig | undefined;
    let faults: readonly FaultRule[] | undefined;
    let webhooks: readonly WebhookConfig[] | undefined;
    let globalReactions: readonly ReactionRule[] | undefined;
    let fallback: FallbackConfig | undefined;
    let coverage: YamlLinkedProgram['coverage'] | undefined;

    if (globalYaml) {
      let rawGlobal: unknown;
      try {
        rawGlobal = yaml.load(globalYaml);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new BootError('BOOT_ERR_DSL_SYNTAX', `Global config YAML parse error: ${message}`, {
          message,
          source: globalYaml.slice(0, 200),
        });
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
      globalReactions = globalConfig.reactions;
      fallback = globalConfig.fallback;
      coverage = globalConfig.coverage;
    }

    // Collect all reactions from boundary files and the global config.
    // Boundary reactions already have `boundary` filled in (R1 parser guarantees it).
    const allReactions: ReactionRule[] = [];
    for (const bc of boundaries) {
      if (bc.reactions && bc.reactions.length > 0) {
        allReactions.push(...bc.reactions);
      }
    }
    if (globalReactions && globalReactions.length > 0) {
      allReactions.push(...globalReactions);
    }

    // Cross-reference validation: validate all reactions against the compiled model.
    if (allReactions.length > 0) {
      validateReactionCrossReferences(allReactions, byBoundaryName);
    }

    // Build the reaction registry keyed by trigger event string.
    const reactionsByTrigger =
      allReactions.length > 0 ? buildReactionRegistry(allReactions) : undefined;

    // Flatten all reactions into a single array for YamlLinkedProgram.reactions.
    const reactions: readonly ReactionRule[] | undefined =
      allReactions.length > 0 ? allReactions : undefined;

    const hasComponents = Object.keys(componentsMap).length > 0;
    const hasUseEntries = allUseEntries.length > 0;

    const partialDsl: YamlLinkedProgram = {
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
      ...(fallback !== undefined ? { fallback } : {}),
      ...(coverage !== undefined ? { coverage } : {}),
      ...(reactions !== undefined ? { reactions } : {}),
      ...(reactionsByTrigger !== undefined ? { reactionsByTrigger } : {}),
      ...(hasComponents ? { components: componentsMap } : {}),
      ...(hasUseEntries ? { use: allUseEntries as readonly UseEntry[] } : {}),
    };

    return partialDsl;
  });
}
