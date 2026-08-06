import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'),
  execSync: jest.fn(),
}));

import { downloadFile, ensureSpecmaticJar } from '../../../src/conformance/binaries.js';

type RequestHandler = (request: http.IncomingMessage, response: http.ServerResponse) => void;

const nativeFetch = globalThis.fetch;

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not expose an address');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('conformance binary downloader', () => {
  let root: string;
  let server: http.Server;
  let baseUrl: string;
  let handler: RequestHandler;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-binaries-'));
    handler = (_request, response) => {
      response.writeHead(404).end();
    };
    server = http.createServer((request, response) => handler(request, response));
    baseUrl = await listen(server);
  });

  afterEach(async () => {
    globalThis.fetch = nativeFetch;
    await close(server);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('follows relative redirects and atomically writes the response body', async () => {
    const payload = Buffer.from('specmatic-jar-payload');
    const requests: string[] = [];
    handler = (request, response) => {
      requests.push(request.url ?? '');
      if (request.url === '/redirect') {
        response.writeHead(300, { location: '/artifact' }).end();
        return;
      }
      response.writeHead(200).end(payload);
    };

    const destination = path.join(root, 'specmatic.jar');
    await downloadFile(`${baseUrl}/redirect`, destination, { expectedSha256: sha256(payload) });

    await expect(fs.readFile(destination)).resolves.toEqual(payload);
    expect(requests).toEqual(['/redirect', '/artifact']);
    await expect(fs.readdir(root)).resolves.toEqual(['specmatic.jar']);
  });

  it('retains HTTP error messages and never leaves a partial cache file', async () => {
    handler = (_request, response) => {
      response.writeHead(404).end('not found');
    };

    const destination = path.join(root, 'specmatic.jar');
    await expect(downloadFile(`${baseUrl}/missing`, destination)).rejects.toThrow(
      `Download failed: HTTP 404 from ${baseUrl}/missing`,
    );

    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it('rejects an artifact whose SHA-256 digest does not match', async () => {
    handler = (_request, response) => {
      response.writeHead(200).end('tampered');
    };

    const destination = path.join(root, 'specmatic.jar');
    await expect(
      downloadFile(`${baseUrl}/artifact`, destination, {
        expectedSha256: sha256(Buffer.from('expected')),
      }),
    ).rejects.toThrow('failed SHA-256 verification');
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it('preserves non-timeout network errors', async () => {
    const expected = new Error('connection refused');
    globalThis.fetch = jest.fn().mockRejectedValue(expected);

    await expect(
      downloadFile('https://example.invalid/specmatic.jar', path.join(root, 'jar')),
    ).rejects.toBe(expected);
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it('retains the unsupported protocol error', async () => {
    const destination = path.join(root, 'specmatic.jar');

    await expect(downloadFile('ftp://example.invalid/specmatic.jar', destination)).rejects.toThrow(
      'Unsupported download protocol: ftp:',
    );
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it('turns an aborted download into a bounded timeout error and cleans up', async () => {
    let downloadStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      downloadStarted = resolve;
    });

    globalThis.fetch = jest.fn((_input, init) => {
      if (!downloadStarted) throw new Error('The test fetch did not start');
      downloadStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });

    const destination = path.join(root, 'specmatic.jar');
    const download = downloadFile('https://example.invalid/specmatic.jar', destination, {
      timeoutMs: 5,
    });
    await started;
    if (!downloadStarted) throw new Error('The test fetch did not start');

    await expect(download).rejects.toThrow(
      'Download timed out after 5 ms from https://example.invalid/specmatic.jar',
    );
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it('uses the existing versioned cache without making a request', async () => {
    const version = `unit-${process.pid}-${Date.now()}`;
    const cacheDirectory = path.resolve(process.cwd(), '.cache');
    const cachePath = path.join(cacheDirectory, `specmatic-${version}.jar`);
    const payload = Buffer.from('cached-specmatic-jar');
    await fs.mkdir(cacheDirectory, { recursive: true });
    await fs.writeFile(cachePath, payload);

    try {
      globalThis.fetch = jest.fn();
      await expect(ensureSpecmaticJar(version, sha256(payload))).resolves.toBe(cachePath);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      await expect(fs.readFile(cachePath)).resolves.toEqual(payload);
    } finally {
      await fs.rm(cachePath, { force: true });
    }
  });

  it('coalesces concurrent requests for the same versioned cache entry', async () => {
    const version = `unit-concurrent-${process.pid}-${Date.now()}`;
    const payload = Buffer.from('concurrent-specmatic-jar');
    let requests = 0;
    handler = (_request, response) => {
      requests += 1;
      setTimeout(() => response.writeHead(200).end(payload), 10);
    };
    globalThis.fetch = jest.fn((_input, init) => nativeFetch(`${baseUrl}/artifact`, init));

    const expectedPath = path.resolve(process.cwd(), '.cache', `specmatic-${version}.jar`);
    try {
      const paths = await Promise.all([
        ensureSpecmaticJar(version, sha256(payload)),
        ensureSpecmaticJar(version, sha256(payload)),
      ]);
      expect(paths).toEqual([expectedPath, expectedPath]);
      expect(requests).toBe(1);
      await expect(fs.readFile(expectedPath)).resolves.toEqual(payload);
    } finally {
      await fs.rm(expectedPath, { force: true });
    }
  });
});
