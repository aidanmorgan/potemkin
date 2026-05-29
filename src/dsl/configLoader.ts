// Reads a potemkin.yaml from disk, resolves modules: globs via tinyglobby,
// validates every boundary module, and returns a typed LoadedConfig ready
// to be installed into the engine.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import * as yaml from 'js-yaml';
import { glob } from 'tinyglobby';

import { BootError } from '../errors.js';
import {
  validatePotemkinConfig,
  validateBoundaryModule,
  type BoundaryModule,
  type PotemkinConfig,
  type PotemkinConfigPlugin,
  type PotemkinConfigSeed,
  type PotemkinConfigWorkflow,
  type PotemkinConfigOverlay,
  type PotemkinConfigGovernance,
} from './configSchema.js';

export interface SpecEndpoint {
  readonly specId: string;
  readonly path: string;
  readonly method: string;
}

export interface ForwardBlocks {
  readonly seeds?: readonly PotemkinConfigSeed[];
  readonly workflow?: PotemkinConfigWorkflow;
  readonly overlay?: PotemkinConfigOverlay;
  readonly governance?: PotemkinConfigGovernance;
}

export interface LoadedModule {
  /** Absolute path to the boundary YAML file. */
  readonly path: string;
  readonly boundary: BoundaryModule;
}

export interface LoadedConfig {
  readonly potemkinConfigPath: string;
  readonly specmaticConfigPath: string;
  readonly modules: readonly LoadedModule[];
  readonly pluginConfig: PotemkinConfigPlugin | undefined;
  readonly forwardBlocks: ForwardBlocks;
  readonly typescript: PotemkinConfig['typescript'];
}

export interface LoadOptions {
  // Spec endpoints (from httpStub.allEndpoints in the plugin). When omitted,
  // contract-path cross-check is skipped; standalone test callers must either
  // pass this or mark every boundary outOfContract:true.
  readonly specEndpoints?: readonly SpecEndpoint[];
}

export async function loadPotemkinConfig(
  potemkinConfigPath: string,
  opts: LoadOptions = {},
): Promise<LoadedConfig> {
  const absConfigPath = path.resolve(potemkinConfigPath);
  const configDir = path.dirname(absConfigPath);

  let configText: string;
  try {
    configText = await fs.readFile(absConfigPath, 'utf8');
  } catch (e) {
    throw new BootError(
      'BOOT_ERR_CONFIG_MISSING',
      `Cannot read potemkin.yaml at ${absConfigPath}: ${(e as Error).message}`,
      { source: absConfigPath },
    );
  }
  let parsedConfig: unknown;
  try {
    parsedConfig = yaml.load(configText);
  } catch (e) {
    throw new BootError(
      'BOOT_ERR_INVALID_YAML',
      `${absConfigPath}: ${(e as Error).message}`,
      { source: absConfigPath },
    );
  }

  const config = validatePotemkinConfig(parsedConfig, { source: absConfigPath });

  const resolvedFiles = await resolveModuleGlobs(config.modules, configDir);

  const modules: LoadedModule[] = [];
  for (const filePath of resolvedFiles) {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (e) {
      throw new BootError(
        'BOOT_ERR_INVALID_YAML',
        `${filePath}: read failed — ${(e as Error).message}`,
        { source: filePath },
      );
    }
    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch (e) {
      throw new BootError(
        'BOOT_ERR_INVALID_YAML',
        `${filePath}: ${(e as Error).message}`,
        { source: filePath },
      );
    }
    // A module file may carry a boundary or a top-level `global:` block
    // (sagas, idempotency, etc.). Only boundary modules are validated here.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      if (rec['boundary'] !== undefined) {
        const boundary = validateBoundaryModule(parsed, { source: filePath });
        modules.push({ path: filePath, boundary });
      }
    }
  }


  if (opts.specEndpoints) {
    runContractPathCrossCheck(modules, opts.specEndpoints, absConfigPath);
  }

  return {
    potemkinConfigPath: absConfigPath,
    specmaticConfigPath: path.resolve(configDir, config.specmatic),
    modules,
    pluginConfig: config.plugin,
    forwardBlocks: {
      ...(config.seeds ? { seeds: config.seeds } : {}),
      ...(config.workflow ? { workflow: config.workflow } : {}),
      ...(config.overlay ? { overlay: config.overlay } : {}),
      ...(config.governance ? { governance: config.governance } : {}),
    },
    typescript: config.typescript,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function resolveModuleGlobs(
  patterns: readonly string[],
  cwd: string,
): Promise<string[]> {
  const matches = await glob([...patterns], {
    cwd,
    absolute: true,
    dot: false,
    onlyFiles: true,
  });
  if (matches.length === 0) {
    throw new BootError(
      'BOOT_ERR_NO_MODULES',
      `No module files matched: ${patterns.join(', ')}`,
      { patterns: [...patterns], cwd },
    );
  }
  // De-duplicate by absolute path.
  return [...new Set(matches.map((m) => path.resolve(cwd, m)))].sort();
}

function runContractPathCrossCheck(
  modules: readonly LoadedModule[],
  specEndpoints: readonly SpecEndpoint[],
  source: string,
): void {
  // Build the deduped (specId, path, method) set.
  const byKey = new Set<string>();
  const bySpecPath = new Map<string, Set<string>>(); // specId|path → set(method)
  const availableSpecIds = new Set<string>();
  for (const e of specEndpoints) {
    availableSpecIds.add(e.specId);
    byKey.add(`${e.specId}|${e.path}|${e.method.toUpperCase()}`);
    const k = `${e.specId}|${e.path}`;
    if (!bySpecPath.has(k)) bySpecPath.set(k, new Set());
    bySpecPath.get(k)!.add(e.method.toUpperCase());
  }

  for (const m of modules) {
    const b = m.boundary;
    if (b.outOfContract === true) continue;
    if (!availableSpecIds.has(b.specId)) {
      throw new BootError(
        'BOOT_ERR_UNKNOWN_SPEC_ID',
        `${m.path}: boundary "${b.boundary}" references unknown specId "${b.specId}". Available: ${[...availableSpecIds].join(', ')}`,
        { source, boundary: b.boundary, specId: b.specId, available: [...availableSpecIds] },
      );
    }
    const cpKey = `${b.specId}|${b.contractPath}`;
    if (!bySpecPath.has(cpKey)) {
      throw new BootError(
        'BOOT_ERR_UNKNOWN_CONTRACT_PATH',
        `${m.path}: boundary "${b.boundary}" contractPath "${b.contractPath}" not present in spec "${b.specId}"`,
        { source, boundary: b.boundary, specId: b.specId, contractPath: b.contractPath },
      );
    }
    if (b.methods && b.methods.length > 0) {
      const available = bySpecPath.get(cpKey)!;
      for (const m_ of b.methods) {
        if (!available.has(m_.toUpperCase())) {
          throw new BootError(
            'BOOT_ERR_UNKNOWN_CONTRACT_PATH',
            `${m.path}: boundary "${b.boundary}" declares method "${m_}" not present at ${b.specId} ${b.contractPath}`,
            { source, boundary: b.boundary, specId: b.specId, path: b.contractPath, method: m_ },
          );
        }
      }
    }
  }
}
