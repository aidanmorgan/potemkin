import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { glob } from 'tinyglobby';

import type { OpenApiDoc, OpenApiLoadObservability } from '../contract/loader.js';
import type { RuntimeCompilationContext, RuntimeSystem } from '../runtime/system.js';
import type { RuntimeModel } from '../model/index.js';
import type { TransitionModel } from '../model/transitionModel.js';
import { loadConfiguredTypeScriptSources } from './configuredTypeScript.js';
import { loadConfiguredYamlSources } from './configuredYaml.js';
import type { ConfiguredRuntimeSources } from './configuredTypes.js';
import type { YamlCompilationObservability } from './yamlParser.js';

export interface ConfiguredRuntimeWatcherScheduler {
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export interface ConfiguredRuntimeWatcherOptions {
  readonly configPath: string;
  readonly openapi: OpenApiDoc;
  readonly system: RuntimeSystem;
  readonly initialSources: ConfiguredRuntimeSources;
  readonly compile: (
    sources: ConfiguredRuntimeSources,
    context: RuntimeCompilationContext,
  ) => Promise<RuntimeModel>;
  /** Rebuilds the read-only static model alongside a source reload. */
  readonly model?: (sources: ConfiguredRuntimeSources) => Promise<TransitionModel | undefined>;
  readonly onError?: (error: unknown) => void;
  readonly scheduler?: ConfiguredRuntimeWatcherScheduler;
  readonly authoringObservability?: OpenApiLoadObservability & YamlCompilationObservability;
}

export interface ConfiguredRuntimeWatcher {
  reload(): Promise<ConfiguredRuntimeReloadResult>;
  stop(): Promise<void>;
}

export interface ConfiguredRuntimeReloadResult {
  readonly reloaded: true;
  readonly configurationPath: string;
  readonly openapiPathCount: number;
  readonly yamlModuleCount: number;
  readonly typescriptFileCount: number;
}

export const DEFAULT_CONFIG_WATCH_INTERVAL_MS = 10_000;

interface FileFingerprint {
  readonly mtimeMs: number;
  readonly size: number;
}

type FileSnapshot = ReadonlyMap<string, FileFingerprint>;

/**
 * Poll the configuration and all configured source globs. Polling is
 * deliberate: it behaves consistently on bind mounts and Docker volumes where
 * native filesystem events are frequently dropped or delayed.
 */
export async function startConfiguredRuntimeWatcher(
  options: ConfiguredRuntimeWatcherOptions,
): Promise<ConfiguredRuntimeWatcher> {
  const scheduler = options.scheduler ?? createDefaultScheduler();
  let activeSources = options.initialSources;
  let snapshot = await snapshotSources(activeSources);
  let stopped = false;
  let pollInFlight = false;
  let reloadInFlight: Promise<ConfiguredRuntimeReloadResult> | undefined;
  let timer: unknown;

  const schedule = (): void => {
    if (stopped) return;
    timer = scheduler.setTimeout(() => void poll(), watchIntervalMs(activeSources));
  };

  const updatePolling = (): void => {
    // The configuration file is always part of the watched source graph. A
    // source block may opt out of TypeScript source polling, but that must not
    // disable reloading when potemkin.yml itself changes.
    if (timer !== undefined) scheduler.clearTimeout(timer);
    timer = undefined;
    if (!pollInFlight) schedule();
  };

  const reload = (): Promise<ConfiguredRuntimeReloadResult> => {
    if (reloadInFlight !== undefined) return reloadInFlight;
    const operation = (async (): Promise<ConfiguredRuntimeReloadResult> => {
      const nextSources = await loadSources(
        options.configPath,
        activeSources.openapi,
        options.authoringObservability,
      );
      const dependencies = options.system.engine.program.dependencies;
      const nextProgram = await options.compile(nextSources, {
        openapi: nextSources.openapi,
        dependencies,
      });
      const nextTransitionModel =
        options.model === undefined ? undefined : await options.model(nextSources);

      // A changed source graph starts from the new program's initialization
      // state. No events or entities from the previous source graph survive.
      await options.system.reload(nextProgram, {
        clear: true,
        openapi: nextSources.openapi,
        sourceByBoundary: nextSources.loaded.boundarySourcePaths,
        ...(nextTransitionModel === undefined ? {} : { transitionModel: nextTransitionModel }),
      });
      options.system.configuration = nextSources.loaded.configuration;
      activeSources = nextSources;
      snapshot = await snapshotSources(activeSources);
      updatePolling();
      return {
        reloaded: true,
        configurationPath: nextSources.loaded.potemkinConfigPath,
        openapiPathCount: nextSources.loaded.configuration.openapi?.length ?? 0,
        yamlModuleCount:
          nextSources.loaded.boundaryModulePaths.length +
          nextSources.loaded.globalModulePaths.length,
        typescriptFileCount: nextSources.files?.length ?? 0,
      };
    })();
    const tracked = operation.finally(() => {
      if (reloadInFlight === tracked) reloadInFlight = undefined;
    });
    reloadInFlight = tracked;
    return tracked;
  };

  const poll = async (): Promise<void> => {
    if (stopped || pollInFlight) return;
    pollInFlight = true;
    try {
      const current = await snapshotSources(activeSources);
      if (!sameSnapshot(snapshot, current)) {
        await reload();
      }
    } catch (error) {
      options.onError?.(error);
    } finally {
      pollInFlight = false;
      schedule();
    }
  };

  schedule();

  return {
    reload,
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) scheduler.clearTimeout(timer);
      while (pollInFlight || reloadInFlight !== undefined) await scheduler.sleep(5);
    },
  };
}

async function loadSources(
  configPath: string,
  openapi: OpenApiDoc,
  authoringObservability: OpenApiLoadObservability & YamlCompilationObservability = {},
): Promise<ConfiguredRuntimeSources> {
  const yaml = await loadConfiguredYamlSources(configPath, openapi, authoringObservability);
  const typescript = await loadConfiguredTypeScriptSources(yaml.loaded, yaml.openapi);
  return { ...yaml, ...typescript };
}

function createDefaultScheduler(): ConfiguredRuntimeWatcherScheduler {
  return {
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimeout: (handle) => {
      if (typeof handle === 'number' || isNodeTimeoutHandle(handle)) clearTimeout(handle);
    },
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  };
}

function isNodeTimeoutHandle(value: unknown): value is NodeJS.Timeout {
  return (
    typeof value === 'object' &&
    value !== null &&
    'hasRef' in value &&
    typeof value.hasRef === 'function'
  );
}

async function snapshotSources(sources: ConfiguredRuntimeSources): Promise<FileSnapshot> {
  const configPath = path.resolve(sources.loaded.potemkinConfigPath);
  const configDir = path.dirname(configPath);
  const patterns = sources.loaded.watchGlobs;
  const ignores = sources.loaded.watchIgnores;

  const matches = await glob(patterns, {
    cwd: configDir,
    absolute: true,
    onlyFiles: true,
    ignore: ignores.length === 0 ? undefined : ignores,
  });
  const files = [
    ...new Set([
      configPath,
      ...matches.map((file) => path.resolve(file)),
      ...(sources.typescriptDependencyFiles ?? []).map((file) => path.resolve(file)),
    ]),
  ].sort();
  const entries = await Promise.all(
    files.map(async (file): Promise<[string, FileFingerprint] | undefined> => {
      try {
        const stat = await fs.stat(file);
        return [file, { mtimeMs: stat.mtimeMs, size: stat.size }];
      } catch {
        return undefined;
      }
    }),
  );
  return new Map(
    entries.filter((entry): entry is [string, FileFingerprint] => entry !== undefined),
  );
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  if (left.size !== right.size) return false;
  for (const [file, previous] of left) {
    const current = right.get(file);
    if (
      current === undefined ||
      current.mtimeMs !== previous.mtimeMs ||
      current.size !== previous.size
    )
      return false;
  }
  return true;
}

function watchIntervalMs(sources: ConfiguredRuntimeSources): number {
  return sources.loaded.typescript?.watchIntervalMs ?? DEFAULT_CONFIG_WATCH_INTERVAL_MS;
}
