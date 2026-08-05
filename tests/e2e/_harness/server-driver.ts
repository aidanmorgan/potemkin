/** Spawn the production Potemkin CLI server for full-stack e2e tests. */

import * as cp from 'node:child_process';
import * as http from 'node:http';
import * as path from 'node:path';

import { getFreePort } from '../../../src/conformance/portAllocator.js';

export interface ServerProcessHandle {
  readonly port: number;
  readonly url: string;
  stop(): Promise<void>;
}

export async function startCliServer(options: {
  readonly configPath: string;
  readonly pluginControlUrl?: string;
  readonly adminToken?: string;
  readonly port?: number;
}): Promise<ServerProcessHandle> {
  const port = options.port ?? (await getFreePort());
  const tsxCli = path.resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
  const cliEntry = path.resolve(process.cwd(), 'src/cli/index.ts');
  const child = cp.spawn(
    process.execPath,
    [
      tsxCli,
      cliEntry,
      'server',
      '--config',
      options.configPath,
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...(options.pluginControlUrl === undefined
          ? {}
          : { POTEMKIN_PLUGIN_CONTROL_URL: options.pluginControlUrl }),
        ...(options.adminToken === undefined ? {} : { ADMIN_TOKEN: options.adminToken }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  child.stdout?.on('data', (chunk: Buffer) =>
    process.stdout.write(`[potemkin] ${chunk.toString()}`),
  );
  child.stderr?.on('data', (chunk: Buffer) =>
    process.stderr.write(`[potemkin] ${chunk.toString()}`),
  );

  await waitForServer(`http://127.0.0.1:${port}/`, child, 60_000);

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    stop: () => stopChild(child),
  };
}

async function waitForServer(
  targetUrl: string,
  child: cp.ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Potemkin CLI server exited with code ${child.exitCode}`);
    const reachable = await new Promise<boolean>((resolve) => {
      const request = http.get(targetUrl, (response) => {
        response.resume();
        resolve(true);
      });
      request.on('error', () => resolve(false));
      request.setTimeout(1_000, () => {
        request.destroy();
        resolve(false);
      });
    });
    if (reachable) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  await stopChild(child);
  throw new Error(
    `Potemkin CLI server at ${targetUrl} did not become ready within ${timeoutMs} ms`,
  );
}

function stopChild(child: cp.ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
