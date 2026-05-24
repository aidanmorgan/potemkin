/**
 * Specmatic JVM driver — spawns a real Specmatic stub server process with the
 * plugin JAR on the classpath, waits for it to be ready, and provides a clean
 * shutdown helper.
 */

import * as cp from 'node:child_process';
import * as http from 'node:http';
import { getFreePort } from './port-allocator';

export interface SpecmaticHandle {
  readonly stubPort: number;
  readonly process: cp.ChildProcess;
  shutdown(): Promise<void>;
  ready(): Promise<void>;
}

export interface SpecmaticOptions {
  /** Path to the OpenAPI YAML contract file. */
  readonly contractPath: string;
  /** Absolute path to the plugin fat-JAR. */
  readonly pluginJar: string;
  /** Absolute path to the specmatic.jar. */
  readonly specmaticJar: string;
  /** Stub port to bind.  Defaults to a free ephemeral port. */
  readonly stubPort?: number;
  /** Extra environment variables passed to the JVM process. */
  readonly extraEnv?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Probe a URL until it responds with any HTTP status (means the server is up). */
async function probeUntilUp(targetUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get(targetUrl, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
    });

    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(`Specmatic stub at ${targetUrl} did not become ready within ${timeoutMs} ms`);
}

// ---------------------------------------------------------------------------
// Start Specmatic
// ---------------------------------------------------------------------------

export async function startSpecmatic(opts: SpecmaticOptions): Promise<SpecmaticHandle> {
  const stubPort = opts.stubPort ?? (await getFreePort());
  const sep = process.platform === 'win32' ? ';' : ':';
  const classpath = `${opts.specmaticJar}${sep}${opts.pluginJar}`;

  const jvmArgs = [
    '-cp', classpath,
    'application.SpecmaticApplication',
    'stub',
    '--port', String(stubPort),
    opts.contractPath,
  ];

  const childEnv = {
    ...process.env,
    ...opts.extraEnv,
  };

  const child = cp.spawn('java', jvmArgs, {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Tag all output with [specmatic] so it is identifiable in test output.
  child.stdout?.on('data', (chunk: Buffer) => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) process.stdout.write(`[specmatic] ${line}\n`);
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) process.stderr.write(`[specmatic] ${line}\n`);
    }
  });

  child.on('error', (err) => {
    process.stderr.write(`[specmatic] Process error: ${err.message}\n`);
  });

  // ---- Handle object -------------------------------------------------------

  let readyResolved = false;

  const handle: SpecmaticHandle = {
    stubPort,
    process: child,

    async ready() {
      if (readyResolved) return;
      // Specmatic doesn't expose /actuator/health — probe the stub root.
      // Any HTTP response (including 400) means the server is up.
      await probeUntilUp(`http://127.0.0.1:${stubPort}/`, 60_000);
      readyResolved = true;
    },

    async shutdown() {
      return new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }

        const timer = setTimeout(() => {
          child.kill('SIGKILL');
        }, 5_000);

        child.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });

        child.kill('SIGTERM');
      });
    },
  };

  return handle;
}
