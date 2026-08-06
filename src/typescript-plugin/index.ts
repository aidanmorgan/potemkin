import * as fs from 'node:fs';
import * as path from 'node:path';

import type ts from 'typescript';

import { watchConfiguredOpenApiBindings } from '../generation/service.js';

interface PluginConfig {
  readonly configPath?: string;
  readonly outputDirectory?: string;
  readonly intervalMs?: number;
}

/** TypeScript language-service plugin used by VS Code and compatible tsserver hosts. */
function init({ typescript }: { typescript: typeof ts }): ts.server.PluginModule {
  void typescript;
  const projectConfigs = new WeakMap<ts.server.Project, PluginConfig>();
  return {
    create(createInfo) {
      const projectRoot = createInfo.project.getCurrentDirectory();
      const config = parsePluginConfig(createInfo.config);
      projectConfigs.set(createInfo.project, config);
      const configPath = findConfigPath(projectRoot, config.configPath);
      if (configPath !== undefined) {
        void watchConfiguredOpenApiBindings({
          configPath,
          projectRoot,
          outputDirectory: config.outputDirectory,
          intervalMs: config.intervalMs,
          onUpdate: () => createInfo.languageService.cleanupSemanticCache(),
        });
      }
      return createInfo.languageService;
    },
    getExternalFiles(project) {
      const projectRoot = project.getCurrentDirectory();
      const config = projectConfigs.get(project);
      const outputDirectory = config?.outputDirectory ?? path.join(projectRoot, 'gen-src');
      return [
        path.resolve(projectRoot, outputDirectory, 'openapi.d.ts'),
        path.resolve(projectRoot, outputDirectory, 'potemkin-sdk.d.ts'),
      ];
    },
  };
}

function parsePluginConfig(value: unknown): PluginConfig {
  if (!isRecord(value)) return {};

  const configPath = optionalString(value['configPath']);
  const outputDirectory = optionalString(value['outputDirectory']);
  const intervalMs = optionalFiniteNumber(value['intervalMs']);

  return {
    ...(configPath === undefined ? {} : { configPath }),
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
    ...(intervalMs === undefined ? {} : { intervalMs }),
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function findConfigPath(
  projectRoot: string,
  configuredPath: string | undefined,
): string | undefined {
  const candidate = path.resolve(projectRoot, configuredPath ?? 'potemkin.yml');
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
    const nested = path.join(candidate, 'potemkin.yml');
    if (fs.existsSync(nested)) return nested;
  }
  return undefined;
}

export = init;
