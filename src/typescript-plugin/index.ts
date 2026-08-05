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
      const config = (createInfo.config ?? {}) as PluginConfig;
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
