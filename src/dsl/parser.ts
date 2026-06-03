import * as yaml from 'js-yaml';
import { BootError } from '../errors.js';
import { createLogger, getTracer, withSpan } from '../observability/index.js';
import { validateBoundaryConfig, validateGlobalConfig } from './schema.js';
import type { AuthConfig, BoundaryConfig, CompiledDsl, FaultRule, HateoasConfig, ReactionRule, ReactionsByTrigger, SagaConfig, IdempotencyConfig, DerivedProjectionConfig, LatencyConfig, SecurityHeadersConfig, VersioningConfig, WebhookConfig } from './types.js';
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
 * Build a reaction registry keyed by trigger event string from all reactions
 * across all boundary files and the optional global reactions array.
 *
 * Keys are either "<Boundary>:<EventType>" (qualified) or "<EventType>" (bare).
 * For a given emitted event, callers look up both the qualified and bare keys
 * and union the results — matching the same convention used by derived projections
 * in src/projections/engine.ts (the "Boundary:Event".split(':') pattern).
 */
export function buildReactionRegistry(
  allReactions: readonly ReactionRule[],
): ReactionsByTrigger {
  const map = new Map<string, ReactionRule[]>();
  for (const reaction of allReactions) {
    const key = reaction.on;
    let bucket = map.get(key);
    if (bucket === undefined) {
      bucket = [];
      map.set(key, bucket);
    }
    bucket.push(reaction);
  }
  return map as ReactionsByTrigger;
}

/**
 * Cross-reference validation for reaction rules against the compiled boundary map.
 *
 * Validates:
 *  (a) The reacting `boundary` field names a known boundary in byBoundaryName.
 *  (b) The reaction `emit` event type exists in the reacting boundary's event_catalog.
 *  (c) The reaction `on` trigger event must be emittable by at least one boundary:
 *      - qualified "Boundary:EventType" — that exact boundary's catalog must contain the type;
 *      - bare "EventType" — any boundary's catalog must contain the type.
 *
 * Validates against the COMPILED byBoundaryName (post-merge), not a per-file view.
 *
 * @throws {BootError} with code BOOT_ERR_DSL_REFERENCE on any violation.
 */
export function validateReactionCrossReferences(
  allReactions: readonly ReactionRule[],
  byBoundaryName: Record<string, BoundaryConfig>,
): void {
  // Build a global event-type → boundary names map for bare-trigger lookups.
  const allEventTypes = new Map<string, string[]>();
  for (const [bName, bc] of Object.entries(byBoundaryName)) {
    for (const entry of bc.eventCatalog) {
      let list = allEventTypes.get(entry.type);
      if (list === undefined) {
        list = [];
        allEventTypes.set(entry.type, list);
      }
      list.push(bName);
    }
  }

  for (const reaction of allReactions) {
    const reactingBoundaryName = reaction.boundary!;
    const label = reaction.name ? `reaction "${reaction.name}"` : `reaction on "${reaction.on}"`;

    // (a) Reacting boundary must exist in compiled model.
    const reactingBoundary = byBoundaryName[reactingBoundaryName];
    if (reactingBoundary === undefined) {
      throw new BootError(
        'BOOT_ERR_DSL_REFERENCE',
        `${label}: reacting boundary "${reactingBoundaryName}" is not a known boundary`,
        { reaction: reaction.name ?? reaction.on, boundary: reactingBoundaryName },
      );
    }

    // (b) The emitted event type must exist in the reacting boundary's event_catalog.
    const reactingCatalogTypes = new Set(reactingBoundary.eventCatalog.map((e) => e.type));
    if (!reactingCatalogTypes.has(reaction.emit)) {
      throw new BootError(
        'BOOT_ERR_DSL_REFERENCE',
        `${label}: "emit" event type "${reaction.emit}" is not in boundary "${reactingBoundaryName}" event_catalog`,
        { reaction: reaction.name ?? reaction.on, boundary: reactingBoundaryName, missingType: reaction.emit },
      );
    }

    // (c) The trigger "on" must be emittable by some boundary.
    const onValue = reaction.on;
    if (onValue.includes(':')) {
      // Qualified "Boundary:EventType" — the named boundary must exist and have that event.
      const [triggerBoundaryName, triggerEventType] = onValue.split(':', 2) as [string, string];
      const triggerBoundary = byBoundaryName[triggerBoundaryName];
      if (triggerBoundary === undefined) {
        throw new BootError(
          'BOOT_ERR_DSL_REFERENCE',
          `${label}: trigger "on" boundary "${triggerBoundaryName}" (in "${onValue}") is not a known boundary`,
          { reaction: reaction.name ?? reaction.on, triggerBoundary: triggerBoundaryName, on: onValue },
        );
      }
      const triggerCatalogTypes = new Set(triggerBoundary.eventCatalog.map((e) => e.type));
      if (!triggerCatalogTypes.has(triggerEventType)) {
        throw new BootError(
          'BOOT_ERR_DSL_REFERENCE',
          `${label}: trigger event type "${triggerEventType}" is not in boundary "${triggerBoundaryName}" event_catalog (on: "${onValue}")`,
          { reaction: reaction.name ?? reaction.on, triggerBoundary: triggerBoundaryName, missingType: triggerEventType, on: onValue },
        );
      }
    } else {
      // Bare "EventType" — any boundary must emit it.
      if (!allEventTypes.has(onValue)) {
        throw new BootError(
          'BOOT_ERR_DSL_REFERENCE',
          `${label}: trigger event type "${onValue}" is not found in any boundary's event_catalog`,
          { reaction: reaction.name ?? reaction.on, missingType: onValue, on: onValue },
        );
      }
    }
  }
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
    let globalReactions: readonly ReactionRule[] | undefined;

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
      globalReactions = globalConfig.reactions;
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
    const reactionsByTrigger = allReactions.length > 0
      ? buildReactionRegistry(allReactions)
      : undefined;

    // Flatten all reactions into a single array for CompiledDsl.reactions.
    const reactions: readonly ReactionRule[] | undefined = allReactions.length > 0
      ? allReactions
      : undefined;

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
      ...(reactions !== undefined ? { reactions } : {}),
      ...(reactionsByTrigger !== undefined ? { reactionsByTrigger } : {}),
    };

    const hasScripts = boundaries.some(b => b.scripts && b.scripts.length > 0);
    if (hasScripts) {
      const scriptRegistry = buildScriptRegistry(partialDsl as CompiledDsl, log);
      return { ...partialDsl, scriptRegistry };
    }

    return partialDsl as CompiledDsl;
  });
}
