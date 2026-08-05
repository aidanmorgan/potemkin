import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import ts from 'typescript';
import { watchConfiguredOpenApiBindings } from '../../../src/generation/service.js';
import plugin from '../../../src/typescript-plugin/index.js';

jest.mock('../../../src/generation/service.js', () => ({
  watchConfiguredOpenApiBindings: jest.fn(),
}));

jest.mock('openapi-typescript', () => ({
  __esModule: true,
  default: async () => [],
  astToString: () => '',
}));

describe('TypeScript language-service adapter', () => {
  it('exposes only generated declarations as project external files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-ts-plugin-'));
    try {
      const project = { getCurrentDirectory: () => root } as unknown as ts.server.Project;
      const languageService = { cleanupSemanticCache: jest.fn() } as unknown as ts.LanguageService;
      const module = plugin({ typescript: ts });

      const created = module.create({
        project,
        config: { outputDirectory: 'generated' },
        languageService,
      } as unknown as ts.server.PluginCreateInfo);
      expect(created).toBe(languageService);
      expect(module.getExternalFiles?.(project, 0 as ts.ProgramUpdateLevel)).toEqual([
        path.join(root, 'generated', 'openapi.d.ts'),
        path.join(root, 'generated', 'potemkin-sdk.d.ts'),
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('starts the generator watcher and invalidates semantic state after an update', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-ts-plugin-watch-'));
    const watcher = jest.mocked(watchConfiguredOpenApiBindings);
    try {
      const configPath = path.join(root, 'potemkin.yml');
      await fs.writeFile(configPath, 'version: 1\n', 'utf8');
      const cleanupSemanticCache = jest.fn();
      const languageService = { cleanupSemanticCache } as unknown as ts.LanguageService;
      watcher.mockImplementation(async (options) => {
        options.onUpdate?.({} as never);
        return {
          outputFile: path.join(root, 'generated', 'openapi.d.ts'),
          sdkOutputFile: path.join(root, 'generated', 'potemkin-sdk.d.ts'),
          yamlSchemaFile: path.join(root, 'generated', 'potemkin.schema.json'),
          close: jest.fn(),
        };
      });

      const project = { getCurrentDirectory: () => root } as unknown as ts.server.Project;
      const module = plugin({ typescript: ts });
      module.create({
        project,
        config: { outputDirectory: 'generated', intervalMs: 25 },
        languageService,
      } as unknown as ts.server.PluginCreateInfo);

      expect(watcher).toHaveBeenCalledWith(
        expect.objectContaining({
          configPath,
          projectRoot: root,
          outputDirectory: 'generated',
          intervalMs: 25,
        }),
      );
      expect(cleanupSemanticCache).toHaveBeenCalledTimes(1);
    } finally {
      watcher.mockReset();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
