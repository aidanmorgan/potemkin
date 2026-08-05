import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { glob } from 'tinyglobby';

import type { OpenApiDoc } from '../contract/loader.js';
import { loadProjectDescriptor } from '../project/descriptor.js';
import type { LoadedConfig } from '../parser/configLoader.js';
import {
  generateOpenApiBindings,
  type GeneratedOpenApiBindings,
  type OpenApiBindingOptions,
} from '../openapi/bindings.js';
import {
  generatePotemkinYamlSchema,
  type GeneratedPotemkinYamlSchema,
} from '../openapi/yamlSchema.js';

export interface ConfiguredBindingOptions extends OpenApiBindingOptions {
  readonly configPath: string;
}

export interface OpenApiBindingWatchOptions extends ConfiguredBindingOptions {
  /** Polling keeps behaviour consistent across Windows, macOS, and network filesystems. */
  readonly intervalMs?: number;
  readonly onUpdate?: (result: GeneratedScenarioBindings) => void;
  readonly onError?: (error: unknown) => void;
}

export interface OpenApiBindingWatcher {
  readonly outputFile: string;
  readonly sdkOutputFile: string;
  readonly yamlSchemaFile: string;
  close(): void;
}

export interface GeneratedScenarioBindings extends GeneratedOpenApiBindings {
  readonly yamlSchema: GeneratedPotemkinYamlSchema;
}

export interface ScenarioBindingOptions extends OpenApiBindingOptions {
  readonly openapi: OpenApiDoc;
  readonly loaded: LoadedConfig;
  readonly scenario: NonNullable<OpenApiBindingOptions['scenario']>;
}

/** Generate every derived artifact from one already-merged project snapshot. */
export async function generateScenarioBindings(
  options: ScenarioBindingOptions,
): Promise<GeneratedScenarioBindings> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const outputDirectory = path.resolve(
    options.outputDirectory ?? path.join(projectRoot, 'gen-src'),
  );
  const bindings = await generateOpenApiBindings(options.openapi, {
    ...options,
    projectRoot,
    outputDirectory,
  });
  const yamlSchema = await generatePotemkinYamlSchema({
    openapi: options.openapi,
    loaded: options.loaded,
    outputDirectory,
    scenario: options.scenario,
  });
  return { ...bindings, yamlSchema };
}

export async function generateConfiguredOpenApiBindings(
  options: ConfiguredBindingOptions,
): Promise<GeneratedOpenApiBindings> {
  return generateConfiguredScenarioBindings(options);
}

export async function generateConfiguredScenarioBindings(
  options: ConfiguredBindingOptions,
): Promise<GeneratedScenarioBindings> {
  const configPath = path.resolve(options.configPath);
  const projectRoot = path.resolve(options.projectRoot ?? path.dirname(configPath));
  const descriptor = await loadProjectDescriptor({ configPath });
  const { openapi: document, loaded, scenario } = descriptor;
  return generateScenarioBindings({
    ...options,
    openapi: document,
    loaded,
    scenario,
    projectRoot,
  });
}

/** Generate once and keep declarations/schema current while project sources change. */
export async function watchConfiguredOpenApiBindings(
  options: OpenApiBindingWatchOptions,
): Promise<OpenApiBindingWatcher> {
  const configPath = path.resolve(options.configPath);
  const projectRoot = path.resolve(options.projectRoot ?? path.dirname(configPath));
  const intervalMs = Math.max(250, options.intervalMs ?? 1_000);
  let watchedFiles: readonly string[] = [configPath];
  let signatures = await signaturesFor(watchedFiles);
  let running = false;
  let closed = false;
  const outputDirectory = path.resolve(
    options.outputDirectory ?? path.join(projectRoot, 'gen-src'),
  );
  let outputFile = path.join(outputDirectory, 'openapi.d.ts');
  let sdkOutputFile = path.join(outputDirectory, 'potemkin-sdk.d.ts');
  let yamlSchemaFile = path.join(outputDirectory, 'potemkin.schema.json');

  const refresh = async (): Promise<void> => {
    if (closed || running) return;
    running = true;
    try {
      const descriptor = await loadProjectDescriptor({ configPath });
      const { openapi: document, loaded, scenario } = descriptor;
      const result = await generateScenarioBindings({
        ...options,
        openapi: document,
        loaded,
        scenario,
        projectRoot,
        outputDirectory,
      });
      outputFile = result.outputFile;
      sdkOutputFile = result.sdkOutputFile;
      yamlSchemaFile = result.yamlSchema.outputFile;
      watchedFiles = [
        configPath,
        ...(document.sourcePaths ?? []),
        ...(await scenarioFiles(loaded)),
      ];
      signatures = await signaturesFor(watchedFiles);
      options.onUpdate?.(result);
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  };

  await refresh();
  const timer = setInterval(() => {
    void detectChanges();
  }, intervalMs);

  const detectChanges = async (): Promise<void> => {
    if (closed || running) return;
    const next = await signaturesFor(watchedFiles);
    if (sameSignatures(signatures, next)) return;
    await refresh();
  };

  return {
    get outputFile() {
      return outputFile;
    },
    get sdkOutputFile() {
      return sdkOutputFile;
    },
    get yamlSchemaFile() {
      return yamlSchemaFile;
    },
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}

async function scenarioFiles(loaded: LoadedConfig): Promise<readonly string[]> {
  const configDirectory = path.dirname(loaded.potemkinConfigPath);
  const typescriptFiles =
    loaded.typescript === undefined
      ? []
      : await glob(
          loaded.typescript.scan.flatMap((entry) => entry.include),
          {
            cwd: configDirectory,
            absolute: true,
            onlyFiles: true,
            ignore: loaded.typescript.scan.flatMap((entry) => entry.exclude ?? []),
          },
        );
  return [
    ...loaded.boundaryModulePaths,
    ...loaded.componentModulePaths,
    ...loaded.useMappingModulePaths,
    ...loaded.globalModulePaths,
    ...typescriptFiles,
  ];
}

async function signaturesFor(files: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const entries = await Promise.all(
    files.map(async (file) => {
      try {
        const stat = await fs.stat(file);
        return [file, `${stat.mtimeMs}:${stat.size}`] as const;
      } catch {
        return [file, 'missing'] as const;
      }
    }),
  );
  return new Map(entries);
}

function sameSignatures(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [file, signature] of left) {
    if (right.get(file) !== signature) return false;
  }
  return true;
}
