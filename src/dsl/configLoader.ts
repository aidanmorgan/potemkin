// Reads a potemkin.yaml from disk, resolves modules: globs via tinyglobby,
// then compiles the resolved DSL modules through the SINGLE canonical
// snake_case compiler (compileDsl → validateBoundaryConfig / validateGlobalConfig)
// to produce a fully-populated CompiledDsl. The potemkin.yaml TOP-LEVEL
// (version/specmatic/modules/typescript/plugin/seeds/workflow/overlay/governance)
// is validated by configSchema.validatePotemkinConfig; the boundary/global DSL
// bodies are validated by the snake_case schema validators so the on-disk boot
// path and the inline compileDsl path converge on one dialect.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import * as yaml from 'js-yaml';
import { glob } from 'tinyglobby';

import { BootError } from '../errors.js';
import { compileDsl } from './parser.js';
import type { CompiledDsl } from './types.js';
import {
  validatePotemkinConfig,
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

export interface LoadedConfig {
  readonly potemkinConfigPath: string;
  readonly specmaticConfigPath: string;
  /** Fully-populated CompiledDsl, identical to the inline compileDsl path. */
  readonly compiledDsl: CompiledDsl;
  /** Absolute paths of the boundary module files that fed the compiler. */
  readonly boundaryModulePaths: readonly string[];
  /** Maps each boundary name to the absolute path of the file that declared it. */
  readonly boundarySourcePaths: Readonly<Record<string, string>>;
  /** Absolute paths of global module files (sagas/idempotency/etc, no `boundary:`). */
  readonly globalModulePaths: readonly string[];
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

interface ResolvedModule {
  readonly path: string;
  readonly text: string;
  readonly parsed: unknown;
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

  // Parse every module file, partitioning into boundary modules (carry a
  // `boundary:` key) and global modules (sagas/idempotency/derived_projections/
  // auth — top-level Tier-2 fields, no `boundary:`). Anything that isn't a
  // mapping is skipped silently (e.g. a stray list file).
  const boundaryModules: ResolvedModule[] = [];
  const globalModules: ResolvedModule[] = [];
  for (const filePath of resolvedFiles) {
    let text: string;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch (e) {
      throw new BootError(
        'BOOT_ERR_INVALID_YAML',
        `${filePath}: read failed — ${(e as Error).message}`,
        { source: filePath },
      );
    }
    let parsed: unknown;
    try {
      parsed = yaml.load(text);
    } catch (e) {
      throw new BootError(
        'BOOT_ERR_INVALID_YAML',
        `${filePath}: ${(e as Error).message}`,
        { source: filePath },
      );
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      if (rec['boundary'] !== undefined) {
        boundaryModules.push({ path: filePath, text, parsed });
      } else {
        globalModules.push({ path: filePath, text, parsed });
      }
    }
  }

  // Optional contract-path cross-check (REQ-LOAD-006). Runs against the raw
  // snake_case boundary fields before the compiler validates the bodies, so
  // bad specId/contractPath references fail with their dedicated codes.
  if (opts.specEndpoints) {
    runContractPathCrossCheck(boundaryModules, opts.specEndpoints, absConfigPath);
  }

  // Merge every global module into a single YAML document so compileDsl's
  // single globalYaml parameter sees all top-level Tier-2 blocks.
  const globalYaml = mergeGlobalModules(globalModules);

  // Compile through the one snake_case compiler — this is the SAME call the
  // inline loadFixture path makes, so the produced CompiledDsl is identical.
  const compileModules = boundaryModules.map((m) => ({ name: m.path, yaml: m.text }));
  const compiledDsl = await compileDsl(compileModules, globalYaml);

  // Map each compiled boundary back to the file that declared it (for
  // reducer-conflict source locations). compileDsl preserves the order of
  // compileModules in compiledDsl.boundaries.
  const boundarySourcePaths: Record<string, string> = {};
  for (const m of boundaryModules) {
    const rec = m.parsed as Record<string, unknown>;
    if (typeof rec['boundary'] === 'string') {
      boundarySourcePaths[rec['boundary']] = m.path;
    }
  }

  return {
    potemkinConfigPath: absConfigPath,
    specmaticConfigPath: path.resolve(configDir, config.specmatic),
    compiledDsl,
    boundaryModulePaths: boundaryModules.map((m) => m.path),
    boundarySourcePaths,
    globalModulePaths: globalModules.map((m) => m.path),
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

/**
 * Merge the parsed bodies of every global module into one object, then dump
 * back to a YAML string. compileDsl re-parses this single string via
 * validateGlobalConfig. Returns undefined when there are no global modules.
 * Duplicate top-level keys across files collide loudly.
 */
function mergeGlobalModules(modules: readonly ResolvedModule[]): string | undefined {
  if (modules.length === 0) return undefined;
  if (modules.length === 1) return modules[0].text;

  const merged: Record<string, unknown> = {};
  for (const m of modules) {
    const rec = m.parsed as Record<string, unknown>;
    for (const [k, v] of Object.entries(rec)) {
      if (k in merged) {
        throw new BootError(
          'BOOT_ERR_DSL_DUPLICATE_BOUNDARY',
          `Duplicate global config key "${k}" found in ${m.path}`,
          { key: k, source: m.path },
        );
      }
      merged[k] = v;
    }
  }
  return yaml.dump(merged);
}

function runContractPathCrossCheck(
  modules: readonly ResolvedModule[],
  specEndpoints: readonly SpecEndpoint[],
  source: string,
): void {
  // Build the deduped (specId, path, method) set.
  const bySpecPath = new Map<string, Set<string>>(); // specId|path → set(method)
  const availableSpecIds = new Set<string>();
  for (const e of specEndpoints) {
    availableSpecIds.add(e.specId);
    const k = `${e.specId}|${e.path}`;
    if (!bySpecPath.has(k)) bySpecPath.set(k, new Set());
    bySpecPath.get(k)!.add(e.method.toUpperCase());
  }

  for (const m of modules) {
    const rec = m.parsed as Record<string, unknown>;
    const boundaryName = String(rec['boundary']);
    if (rec['outOfContract'] === true || rec['out_of_contract'] === true) continue;

    const specId = typeof rec['specId'] === 'string'
      ? (rec['specId'] as string)
      : (rec['spec_id'] as string | undefined);
    const contractPath = typeof rec['contractPath'] === 'string'
      ? (rec['contractPath'] as string)
      : (rec['contract_path'] as string | undefined);

    if (typeof specId !== 'string') {
      throw new BootError(
        'BOOT_ERR_MISSING_SPEC_ID',
        `${m.path}: boundary "${boundaryName}" is missing required "specId"`,
        { source: m.path, boundary: boundaryName },
      );
    }
    if (!availableSpecIds.has(specId)) {
      throw new BootError(
        'BOOT_ERR_UNKNOWN_SPEC_ID',
        `${m.path}: boundary "${boundaryName}" references unknown specId "${specId}". Available: ${[...availableSpecIds].join(', ')}`,
        { source, boundary: boundaryName, specId, available: [...availableSpecIds] },
      );
    }
    const cpKey = `${specId}|${contractPath}`;
    if (!bySpecPath.has(cpKey)) {
      throw new BootError(
        'BOOT_ERR_UNKNOWN_CONTRACT_PATH',
        `${m.path}: boundary "${boundaryName}" contractPath "${String(contractPath)}" not present in spec "${specId}"`,
        { source, boundary: boundaryName, specId, contractPath: String(contractPath) },
      );
    }
    const methodsRaw = rec['methods'];
    if (Array.isArray(methodsRaw) && methodsRaw.length > 0) {
      const available = bySpecPath.get(cpKey)!;
      for (const m_ of methodsRaw) {
        if (typeof m_ === 'string' && !available.has(m_.toUpperCase())) {
          throw new BootError(
            'BOOT_ERR_UNKNOWN_CONTRACT_PATH',
            `${m.path}: boundary "${boundaryName}" declares method "${m_}" not present at ${specId} ${String(contractPath)}`,
            { source, boundary: boundaryName, specId, path: String(contractPath), method: m_ },
          );
        }
      }
    }
  }
}
