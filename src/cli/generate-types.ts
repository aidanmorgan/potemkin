import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  generateConfiguredScenarioBindings,
  watchConfiguredOpenApiBindings,
  type OpenApiBindingWatcher,
} from '../generation/service.js';

export interface GenerateTypesArguments {
  readonly configPath: string;
  readonly outputDirectory?: string;
  readonly watch: boolean;
}

export async function runGenerateTypes(args: GenerateTypesArguments): Promise<void> {
  if (!args.watch) {
    const result = await generateConfiguredScenarioBindings({
      configPath: args.configPath,
      outputDirectory: args.outputDirectory,
    });
    const status = result.changed || result.yamlSchema.changed ? 'Generated' : 'Unchanged';
    process.stdout.write(
      `${status} ${result.outputFile}\n${status} ${result.sdkOutputFile}\n${status} ${result.yamlSchema.outputFile}\n`,
    );
    return;
  }

  const watcher: OpenApiBindingWatcher = await watchConfiguredOpenApiBindings({
    configPath: args.configPath,
    outputDirectory: args.outputDirectory,
    onUpdate: (result) => {
      if (result.changed || result.yamlSchema.changed) {
        process.stdout.write(
          `Generated ${result.outputFile}\nGenerated ${result.sdkOutputFile}\nGenerated ${result.yamlSchema.outputFile}\n`,
        );
      }
    },
    onError: (error) => {
      process.stderr.write(`OpenAPI binding update failed: ${errorMessage(error)}\n`);
    },
  });
  process.stdout.write(`Watching ${args.configPath}; press Ctrl+C to stop.\n`);
  const stop = (): void => {
    watcher?.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

export function parseGenerateTypesArguments(argv: readonly string[]): GenerateTypesArguments {
  let configPath: string | undefined;
  let outputDirectory: string | undefined;
  let watch = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--watch') {
      watch = true;
      continue;
    }
    if (argument === '--config' || argument === '-c') {
      configPath = argv[++index];
      continue;
    }
    if (argument === '--output' || argument === '-o') {
      outputDirectory = argv[++index];
      continue;
    }
    if (argument.startsWith('-')) throw new Error(`Unknown generate-types option: ${argument}`);
    configPath ??= argument;
  }
  const resolvedConfig = resolveConfigPath(configPath);
  return {
    configPath: resolvedConfig,
    ...(outputDirectory === undefined ? {} : { outputDirectory: path.resolve(outputDirectory) }),
    watch,
  };
}

function resolveConfigPath(value: string | undefined): string {
  const candidate = path.resolve(value ?? 'potemkin.yml');
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
    const configPath = path.join(candidate, 'potemkin.yml');
    if (fs.existsSync(configPath)) return configPath;
  }
  throw new Error(`No potemkin.yml found at ${candidate}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
