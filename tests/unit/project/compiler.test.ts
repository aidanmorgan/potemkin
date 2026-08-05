import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadOpenApi } from '../../../src/contract/loader.js';
import { loadProjectSources } from '../../../src/project/compiler.js';
import { loadProjectDescriptor } from '../../../src/project/descriptor.js';

describe('project compilation context', () => {
  it('loads configuration and source adapters into one project snapshot', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-project-'));
    try {
      await fs.mkdir(path.join(root, 'dsl'));
      const configPath = path.join(root, 'potemkin.yml');
      const modulePath = path.join(root, 'dsl', 'orders.yaml');
      await fs.writeFile(
        configPath,
        ['version: 1', 'specmatic: specmatic.yaml', 'modules:', '  - dsl/*.yaml'].join('\n'),
        'utf8',
      );
      await fs.writeFile(
        modulePath,
        ['boundary: Orders', 'contract_path: /orders', 'event_catalog: []', 'behaviors: []'].join(
          '\n',
        ),
        'utf8',
      );
      const openapi = await loadOpenApi({
        openapi: '3.0.3',
        info: { title: 'Project', version: '1.0.0' },
        paths: {},
      });
      const sources = await loadProjectSources(configPath, openapi);
      expect(sources.loaded.yamlProgram.modules).toEqual([
        { name: modulePath, yaml: expect.stringContaining('boundary: Orders') },
      ]);
      expect(sources.openapi).toBe(openapi);
      expect(sources.authoring).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('builds one source-neutral descriptor for generation and editor consumers', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-descriptor-'));
    try {
      const configPath = path.join(root, 'potemkin.yml');
      await fs.mkdir(path.join(root, 'dsl'));
      await fs.writeFile(
        path.join(root, 'dsl', 'orders.yaml'),
        'boundary: Orders\ncontract_path: /orders\nevent_catalog: []\nbehaviors: []\n',
        'utf8',
      );
      await fs.writeFile(
        configPath,
        ['version: 1', 'specmatic: specmatic.yaml', 'modules:', '  - dsl/*.yaml'].join('\n'),
        'utf8',
      );
      const openapi = await loadOpenApi({
        openapi: '3.0.3',
        info: { title: 'Descriptor', version: '1.0.0' },
        paths: { '/orders': { post: { operationId: 'createOrder', responses: {} } } },
      });
      const descriptor = await loadProjectDescriptor({
        configPath,
        openapi,
        documents: new Map([[configPath, 'ignored by the loader']]),
      });
      expect(descriptor.openapi).toBe(openapi);
      expect(descriptor.loaded.configuration.version).toBe(1);
      expect(descriptor.scenario.operationIds).toContain('createOrder');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
