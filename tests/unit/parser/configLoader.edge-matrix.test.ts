import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadPotemkinConfig } from '../../../src/parser/configLoader.js';

async function temporaryConfig(): Promise<{
  readonly root: string;
  readonly config: string;
  readonly write: (name: string, contents: string) => Promise<string>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-config-loader-matrix-'));
  const modules = path.join(root, 'modules');
  await fs.mkdir(modules);
  const config = path.join(root, 'potemkin.yml');
  await fs.writeFile(
    config,
    'version: 1\nspecmatic: ./specmatic.yaml\nmodules: [modules/*.yaml]\n',
  );
  return {
    root,
    config,
    write: async (name, contents) => {
      const file = path.join(modules, name);
      await fs.writeFile(file, contents);
      return file;
    },
  };
}

describe('potemkin.yml file loader edge matrix', () => {
  it('preserves YAML merge keys when loading the root configuration', async () => {
    const fixture = await temporaryConfig();
    try {
      await fs.writeFile(
        fixture.config,
        '<<: &defaults\n  version: 1\n  specmatic: ./specmatic.yaml\n  modules: [modules/*.yaml]\n',
      );
      const boundaryPath = await fixture.write(
        'boundary.yaml',
        'boundary: Orders\ncontract_path: /orders\nspec_id: main\n',
      );

      await expect(
        loadPotemkinConfig(fixture.config, {
          specEndpoints: [{ specId: 'main', path: '/orders', method: 'GET' }],
        }),
      ).resolves.toMatchObject({ boundaryModulePaths: [boundaryPath] });
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('preserves js-yaml scalar resolution for dates and YAML 1.2 booleans', async () => {
    const fixture = await temporaryConfig();
    try {
      await fs.writeFile(
        fixture.config,
        'version: 2020-01-01\nspecmatic: ./specmatic.yaml\nmodules: [modules/*.yaml]\n',
      );
      await expect(loadPotemkinConfig(fixture.config)).rejects.toMatchObject({
        code: 'BOOT_ERR_DSL_SCHEMA_VIOLATION',
      });

      await fs.writeFile(
        fixture.config,
        'version: yes\nspecmatic: ./specmatic.yaml\nmodules: [modules/*.yaml]\n',
      );
      await expect(loadPotemkinConfig(fixture.config)).rejects.toMatchObject({
        code: 'BOOT_ERR_DSL_SCHEMA_VIOLATION',
      });
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('partitions boundary, component, use, global, and resource modules and records watch paths', async () => {
    const fixture = await temporaryConfig();
    try {
      const boundaryPath = await fixture.write(
        'boundary.yaml',
        'boundary: Orders\ncontract_path: /orders\nspec_id: main\n',
      );
      const componentPath = await fixture.write(
        'component.yaml',
        'kind: component\nname: Shared\n',
      );
      const usePath = await fixture.write('use.yaml', 'use: []\n');
      const globalPath = await fixture.write('global.yaml', 'idempotency: {}\n');
      const loaded = await loadPotemkinConfig(fixture.config, {
        specEndpoints: [{ specId: 'main', path: '/orders', method: 'GET' }],
      });
      expect(loaded.boundaryModulePaths).toEqual([boundaryPath]);
      expect(loaded.componentModulePaths).toEqual([componentPath]);
      expect(loaded.useMappingModulePaths).toEqual([usePath]);
      expect(loaded.globalModulePaths).toEqual([globalPath]);
      expect(loaded.yamlProgram.modules).toHaveLength(1);
      expect(loaded.yamlProgram.globalYaml).toBe('idempotency: {}\n');
      expect(loaded.watchGlobs).toEqual([path.join(fixture.root, 'modules/*.yaml')]);
      expect(loaded.watchIgnores).toEqual([]);
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('preserves yaml.dump-compatible output when global modules are merged', async () => {
    const fixture = await temporaryConfig();
    try {
      await fixture.write('first.yaml', 'auth: {mode: simple}\n');
      await fixture.write('second.yaml', 'idempotency: {enabled: true}\n');

      const loaded = await loadPotemkinConfig(fixture.config);

      expect(loaded.yamlProgram.globalYaml).toBe(
        'auth:\n  mode: simple\nidempotency:\n  enabled: true\n',
      );
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('expands resource modules only when an OpenAPI document is supplied', async () => {
    const fixture = await temporaryConfig();
    try {
      await fixture.write(
        'resource.yaml',
        'resource: Order\nschema: Order\noperations: [{op: createOrder, emit: OrderCreated}]\n',
      );
      await expect(loadPotemkinConfig(fixture.config)).rejects.toMatchObject({
        code: 'BOOT_ERR_DSL_SYNTAX',
      });
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects missing files, malformed YAML, empty globs, and duplicate global keys', async () => {
    const missing = path.join(os.tmpdir(), 'potemkin-config-loader-missing.yml');
    await expect(loadPotemkinConfig(missing)).rejects.toMatchObject({
      code: 'BOOT_ERR_CONFIG_MISSING',
    });

    const malformedRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'potemkin-config-loader-invalid-'),
    );
    try {
      const malformed = path.join(malformedRoot, 'potemkin.yml');
      await fs.writeFile(malformed, 'version: [');
      await expect(loadPotemkinConfig(malformed)).rejects.toMatchObject({
        code: 'BOOT_ERR_INVALID_YAML',
        details: { source: malformed },
      });

      const empty = path.join(malformedRoot, 'empty.yml');
      await fs.writeFile(
        empty,
        'version: 1\nspecmatic: ./specmatic.yaml\nmodules: [none/*.yaml]\n',
      );
      await expect(loadPotemkinConfig(empty)).rejects.toMatchObject({
        code: 'BOOT_ERR_NO_MODULES',
      });

      const fixture = await temporaryConfig();
      try {
        await fixture.write('first.yaml', 'auth: {mode: simple}\n');
        await fixture.write('second.yaml', 'auth: {mode: jwt}\n');
        await expect(loadPotemkinConfig(fixture.config)).rejects.toMatchObject({
          code: 'BOOT_ERR_DSL_DUPLICATE_BOUNDARY',
        });
      } finally {
        await fs.rm(fixture.root, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(malformedRoot, { recursive: true, force: true });
    }
  });

  it('enforces spec id, contract path, method, and out-of-contract cross-checks', async () => {
    const cases = [
      ['boundary: Orders\ncontract_path: /orders\n', 'BOOT_ERR_MISSING_SPEC_ID'],
      ['boundary: Orders\ncontract_path: /orders\nspec_id: other\n', 'BOOT_ERR_UNKNOWN_SPEC_ID'],
      [
        'boundary: Orders\ncontract_path: /missing\nspec_id: main\n',
        'BOOT_ERR_UNKNOWN_CONTRACT_PATH',
      ],
      [
        'boundary: Orders\ncontract_path: /orders\nspec_id: main\nmethods: [POST]\n',
        'BOOT_ERR_UNKNOWN_CONTRACT_PATH',
      ],
    ] as const;
    for (const [module, code] of cases) {
      const fixture = await temporaryConfig();
      try {
        await fixture.write('boundary.yaml', module);
        await expect(
          loadPotemkinConfig(fixture.config, {
            specEndpoints: [{ specId: 'main', path: '/orders', method: 'GET' }],
          }),
        ).rejects.toMatchObject({ code });
      } finally {
        await fs.rm(fixture.root, { recursive: true, force: true });
      }
    }

    const exempt = await temporaryConfig();
    try {
      await exempt.write('boundary.yaml', 'boundary: External\nout_of_contract: true\n');
      await expect(
        loadPotemkinConfig(exempt.config, {
          specEndpoints: [{ specId: 'main', path: '/orders', method: 'GET' }],
        }),
      ).resolves.toMatchObject({ boundaryModulePaths: [expect.stringContaining('boundary.yaml')] });
    } finally {
      await fs.rm(exempt.root, { recursive: true, force: true });
    }
  });
});
