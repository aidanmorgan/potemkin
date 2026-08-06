import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'yaml';
import {
  closeServer,
  createPluginConfig,
  resolveContractPath,
} from '../../../src/conformance/exampleStack.js';

describe('example stack helpers', () => {
  let temporaryDirectory: string;

  beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'potemkin-example-stack-'));
  });

  afterEach(() => {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('serializes the temporary plugin configuration as structured YAML', () => {
    const exampleDirectory = path.join(temporaryDirectory, 'example: #1');
    const serialized = createPluginConfig(exampleDirectory, 31_415, 27_182);

    expect(parse(serialized)).toEqual({
      version: 1,
      specmatic: path.join(exampleDirectory, 'specmatic.yaml'),
      plugin: {
        engine: {
          url: 'http://127.0.0.1:31415',
          timeoutMs: 5_000,
        },
        controlPort: 27_182,
      },
    });
  });

  it('resolves the only supported contract regardless of extension casing', () => {
    const openapiDirectory = path.join(temporaryDirectory, 'openapi');
    fs.mkdirSync(openapiDirectory);
    fs.writeFileSync(path.join(openapiDirectory, 'service.YAML'), 'openapi: 3.0.0\n');
    fs.writeFileSync(path.join(openapiDirectory, 'README.txt'), 'not a contract\n');

    expect(resolveContractPath(temporaryDirectory)).toBe(
      path.join(openapiDirectory, 'service.YAML'),
    );
  });

  it('rejects multiple supported contracts with a deterministic diagnostic', () => {
    const openapiDirectory = path.join(temporaryDirectory, 'openapi');
    fs.mkdirSync(openapiDirectory);
    for (const file of ['zeta.json', 'alpha.yaml', 'middle.yml']) {
      fs.writeFileSync(path.join(openapiDirectory, file), '{}\n');
    }

    expect(() => resolveContractPath(temporaryDirectory)).toThrow(
      'Expected exactly one OpenAPI contract in',
    );
    expect(() => resolveContractPath(temporaryDirectory)).toThrow(
      'found: alpha.yaml, middle.yml, zeta.json',
    );
  });

  it('propagates server close errors', async () => {
    const server = http.createServer();

    await expect(closeServer(server)).rejects.toMatchObject({
      code: 'ERR_SERVER_NOT_RUNNING',
    });
  });

  it('resolves after a listening server closes successfully', async () => {
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, resolve);
    });

    await expect(closeServer(server)).resolves.toBeUndefined();
  });
});
