import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadConfiguredOpenApi } from '../../../src/parser/configuredOpenApi.js';
import { BootError } from '../../../src/errors.js';
import type { OpenApiDoc } from '../../../src/contract/loader.js';

const document = (operationId: string, route: string): string => `
openapi: "3.0.3"
info: { title: ${operationId}, version: "1.0.0" }
paths:
  ${route}:
    get:
      operationId: ${operationId}
      responses: { "200": { description: ok } }
`;

describe('configuration-driven OpenAPI discovery', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-openapi-config-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('loads and merges multiple configured OpenAPI globs', async () => {
    await fs.writeFile(path.join(root, 'one.yaml'), document('getOne', '/one'));
    await fs.writeFile(path.join(root, 'two.yaml'), document('getTwo', '/two'));
    const config = path.join(root, 'potemkin.yml');
    await fs.writeFile(config, 'openapi:\n  - one.yaml\n  - two.yaml\n');

    const loaded = await loadConfiguredOpenApi(config);

    expect(Object.keys(loaded.paths)).toEqual(['/one', '/two']);
    expect(loaded.operationIdIndex?.get('GET /two')).toBe('getTwo');
  });

  it('discovers the contract through a Specmatic definition', async () => {
    await fs.mkdir(path.join(root, 'contracts'));
    await fs.writeFile(
      path.join(root, 'contracts', 'service.yaml'),
      document('getService', '/service'),
    );
    await fs.writeFile(
      path.join(root, 'specmatic.yaml'),
      'systemUnderTest:\n  service:\n    definitions:\n      - source:\n          fileSystem:\n            directory: contracts\n        specs:\n          - path: service.yaml\n',
    );
    const config = path.join(root, 'potemkin.yml');
    await fs.writeFile(config, 'specmatic: specmatic.yaml\n');

    await expect(loadConfiguredOpenApi(config)).resolves.toMatchObject({
      paths: { '/service': expect.any(Object) },
    });
  });

  it('preserves YAML merge-key discovery for legacy configurations', async () => {
    await fs.writeFile(path.join(root, 'service.yaml'), document('getService', '/service'));
    const specmatic = path.join(root, 'specmatic.yaml');
    await fs.writeFile(
      specmatic,
      'systemUnderTest:\n  service:\n    definitions:\n      - source:\n          fileSystem:\n            directory: .\n        specs:\n          - path: service.yaml\n',
    );
    const config = path.join(root, 'potemkin.yml');
    await fs.writeFile(config, 'defaults: &defaults\n  specmatic: specmatic.yaml\n<<: *defaults\n');

    await expect(loadConfiguredOpenApi(config)).resolves.toMatchObject({
      paths: { '/service': expect.any(Object) },
    });
  });

  it('preserves implicit timestamp resolution at the configuration boundary', async () => {
    const config = path.join(root, 'potemkin.yml');
    await fs.writeFile(config, 'specmatic: 2020-01-01\n');

    await expect(loadConfiguredOpenApi(config)).rejects.toMatchObject({
      code: 'BOOT_ERR_CONTRACT_LOAD',
      details: { path: config, field: 'specmatic' },
    });
  });

  it('uses an explicit fallback only when discovery is unavailable', async () => {
    const fallback: OpenApiDoc = { raw: {}, paths: { '/fallback': {} } };
    const config = path.join(root, 'potemkin.yml');
    await fs.writeFile(config, 'version: 1\n');

    await expect(loadConfiguredOpenApi(config, fallback)).resolves.toBe(fallback);
    await expect(loadConfiguredOpenApi(config)).rejects.toBeInstanceOf(BootError);
  });

  it('does not pass non-string OpenAPI entries through the config boundary', async () => {
    const fallback: OpenApiDoc = { raw: {}, paths: { '/fallback': {} } };
    const config = path.join(root, 'potemkin.yml');
    await fs.writeFile(config, 'openapi:\n  - 42\n');

    await expect(loadConfiguredOpenApi(config, fallback)).resolves.toBe(fallback);
  });

  it('preserves a useful diagnostic when Specmatic YAML is malformed', async () => {
    const specmatic = path.join(root, 'specmatic.yaml');
    await fs.writeFile(specmatic, 'systemUnderTest: [\n');
    const config = path.join(root, 'potemkin.yml');
    await fs.writeFile(config, 'specmatic: specmatic.yaml\n');

    await expect(loadConfiguredOpenApi(config)).rejects.toMatchObject({
      code: 'BOOT_ERR_DSL_SYNTAX',
      details: {
        path: specmatic,
        reason: expect.stringContaining('line'),
      },
    });
  });

  it.each([
    ['malformed potemkin YAML', 'openapi: [', 'BOOT_ERR_DSL_SYNTAX'],
    ['missing Specmatic specs', 'specmatic: specmatic.yaml\n', 'BOOT_ERR_CONTRACT_LOAD'],
  ] as const)('reports %s as a typed boot error', async (_name, content, code) => {
    const config = path.join(root, 'potemkin.yml');
    await fs.writeFile(config, content);
    await expect(loadConfiguredOpenApi(config)).rejects.toMatchObject({ code });
  });
});
