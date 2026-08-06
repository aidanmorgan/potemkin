import type {
  GovernanceDefinition,
  EngineConfigurationResponse,
  PluginConfiguration,
  PotemkinConfiguration,
  SeedDefinition,
  WorkflowDefinition,
  OverlayDefinition,
} from './contracts/config.js';
import { ConfigurationError } from './errors.js';

export function definePotemkinConfig(config: PotemkinConfiguration): PotemkinConfiguration {
  if (config === null || typeof config !== 'object')
    throw new ConfigurationError('configuration must be an object', { field: 'configuration' });
  if (!Number.isInteger(config.version) || config.version < 1)
    throw new ConfigurationError('version must be a positive integer', { field: 'version' });
  if (typeof config.specmatic !== 'string' || config.specmatic.length === 0)
    throw new ConfigurationError('specmatic must be a non-empty string', { field: 'specmatic' });
  if (
    !Array.isArray(config.modules) ||
    config.modules.length === 0 ||
    config.modules.some((module) => typeof module !== 'string' || module.length === 0)
  )
    throw new ConfigurationError('modules must be a non-empty array of paths', {
      field: 'modules',
    });
  return deepFreeze(config);
}

export function definePluginConfig(config: PluginConfiguration): PluginConfiguration {
  return deepFreeze(config);
}

export function defineWorkflowConfig(config: WorkflowDefinition): WorkflowDefinition {
  return deepFreeze(config);
}

export function defineOverlayConfig(config: OverlayDefinition): OverlayDefinition {
  if (config === null || typeof config !== 'object')
    throw new ConfigurationError('overlay must be an object', { field: 'overlay' });
  if (!Array.isArray(config.patches))
    throw new ConfigurationError('overlay.patches must be an array', { field: 'overlay.patches' });
  return deepFreeze(config);
}

export function defineGovernanceConfig(config: GovernanceDefinition): GovernanceDefinition {
  return deepFreeze(config);
}

export function defineSeedConfig(config: SeedDefinition): SeedDefinition {
  if (
    config === null ||
    typeof config !== 'object' ||
    !config.request ||
    typeof config.request.method !== 'string' ||
    typeof config.request.path !== 'string'
  )
    throw new ConfigurationError('seed.request must contain method and path', {
      field: 'seed.request',
    });
  return deepFreeze(config);
}

export function toEngineConfigurationResponse(
  version: string,
  configuration: PotemkinConfiguration,
): EngineConfigurationResponse {
  return deepFreeze({
    engine: 'potemkin-stateful' as const,
    version,
    potemkin: configuration,
    ...(configuration.plugin === undefined ? {} : { pluginMetadata: configuration.plugin }),
  });
}

function deepFreeze<T>(value: T): T {
  const copy = structuredClone(value);
  const visit = (entry: unknown): void => {
    if (entry === null || typeof entry !== 'object' || Object.isFrozen(entry)) return;
    for (const child of Object.values(entry)) visit(child);
    Object.freeze(entry);
  };
  visit(copy);
  return copy;
}
