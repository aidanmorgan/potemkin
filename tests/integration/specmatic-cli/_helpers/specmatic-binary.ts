/**
 * specmatic-binary.ts
 *
 * Downloads and caches the Specmatic jar; spawns it as a child process.
 *
 * Java availability:
 *   Call `javaAvailable()` at the top of each contract test file.
 *   If it returns false, wrap the whole describe block in `describe.skip`.
 *
 * Jar caching:
 *   Cached at tests/integration/specmatic-cli/.cache/specmatic-<version>.jar.
 *   The cache directory is git-ignored.
 */

import { spawn, execFile } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { get as httpsGet } from 'node:https';
import { get as httpGet } from 'node:http';
import { pipeline } from 'node:stream/promises';
import * as net from 'node:net';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SPECMATIC_VERSION = '2.46.1';

const SPECMATIC_JAR_URL = `https://github.com/specmatic/specmatic/releases/download/${SPECMATIC_VERSION}/specmatic.jar`;

/** Absolute path to the .cache directory next to this file. */
const CACHE_DIR = join(__dirname, '..', '.cache');

/** Absolute path to the cached jar file. */
const JAR_PATH = join(CACHE_DIR, `specmatic-${SPECMATIC_VERSION}.jar`);

// ---------------------------------------------------------------------------
// Java detection
// ---------------------------------------------------------------------------

/**
 * Returns true if `java` is on the PATH and exits with code 0.
 * Caches the result after the first call.
 */
let _javaAvailable: boolean | undefined;

export async function javaAvailable(): Promise<boolean> {
  if (_javaAvailable !== undefined) return _javaAvailable;

  return new Promise((resolve) => {
    execFile('java', ['-version'], { timeout: 5000 }, (err) => {
      _javaAvailable = err === null || err.code === 0;
      // java -version exits 0 even when it prints to stderr; check for ENOENT
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        _javaAvailable = false;
      } else {
        _javaAvailable = !err;
      }
      resolve(_javaAvailable);
    });
  });
}

// ---------------------------------------------------------------------------
// Jar acquisition
// ---------------------------------------------------------------------------

/**
 * Ensures the Specmatic jar is present in the cache directory.
 * Downloads it from GitHub releases if not already cached.
 *
 * @param version  Specmatic version tag (default: SPECMATIC_VERSION constant).
 * @returns        Absolute path to the cached jar.
 */
export async function ensureSpecmaticJar(version?: string): Promise<string> {
  const ver = version ?? SPECMATIC_VERSION;
  const jarPath = ver === SPECMATIC_VERSION
    ? JAR_PATH
    : join(CACHE_DIR, `specmatic-${ver}.jar`);
  const jarUrl = ver === SPECMATIC_VERSION
    ? SPECMATIC_JAR_URL
    : `https://github.com/specmatic/specmatic/releases/download/${ver}/specmatic.jar`;

  if (existsSync(jarPath)) return jarPath;

  await mkdir(CACHE_DIR, { recursive: true });

  await downloadFile(jarUrl, jarPath);

  return jarPath;
}

/** Download a file via HTTP/HTTPS following up to one redirect. */
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const getModule = url.startsWith('https') ? httpsGet : httpGet;

    getModule(url, { headers: { 'User-Agent': 'specmatic-cli-integration-test' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        const redirectUrl = res.headers['location'];
        if (!redirectUrl) {
          reject(new Error(`Redirect without Location header from ${url}`));
          return;
        }
        res.resume();
        downloadFile(redirectUrl, dest).then(resolve, reject);
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Failed to download ${url}: HTTP ${res.statusCode ?? 'unknown'}`));
        return;
      }

      const ws = createWriteStream(dest);
      pipeline(res, ws).then(resolve, reject);
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Process execution helpers
// ---------------------------------------------------------------------------

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Run `java -jar <specmaticJar> ...args` in the given working directory.
 * Returns { stdout, stderr, exitCode } when the process exits.
 */
export async function runSpecmatic(
  args: string[],
  cwd?: string,
  env?: Record<string, string>,
): Promise<RunResult> {
  const jarPath = await ensureSpecmaticJar();

  return new Promise((resolve) => {
    const childEnv = env ? { ...process.env, ...env } : process.env;

    const child = spawn('java', ['-jar', jarPath, ...args], {
      cwd,
      env: childEnv as Record<string, string>,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    child.on('error', (err) => {
      resolve({ stdout, stderr: stderr + `\nProcess error: ${err.message}`, exitCode: 1 });
    });
  });
}

// ---------------------------------------------------------------------------
// Stub server helpers
// ---------------------------------------------------------------------------

export interface StubServer {
  /** Shut down the stub server process. */
  stop(): Promise<void>;
}

/**
 * Wait until a TCP port accepts connections (used to detect when a server is ready).
 */
function waitForPort(port: number, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    function attempt() {
      const socket = new net.Socket();

      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });

      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out waiting for port ${port} to be available`));
          return;
        }
        setTimeout(attempt, 200);
      });

      socket.connect(port, '127.0.0.1');
    }

    attempt();
  });
}

/**
 * Start `java -jar specmatic.jar mock --port=<port> ...contractPaths` and wait
 * until the port accepts TCP connections before resolving.
 *
 * @param contractPaths  Paths to OpenAPI/Specmatic contract files.
 * @param port           Port for the stub server to listen on.
 * @param extraArgs      Additional CLI args (e.g. `--data=<dir>`).
 * @returns              Handle with `stop()` to shut down the process.
 */
export async function startSpecmaticStubServer(
  contractPaths: string[],
  port: number,
  extraArgs: string[] = [],
): Promise<StubServer> {
  const jarPath = await ensureSpecmaticJar();

  const args = [
    '-jar', jarPath,
    'mock',
    `--port=${port}`,
    ...extraArgs,
    ...contractPaths,
  ];

  const child = spawn('java', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Swallow output (suppress noise in test logs)
  child.stdout?.resume();
  child.stderr?.resume();

  // Wait for port to accept connections before returning
  await waitForPort(port, 30000);

  return {
    stop(): Promise<void> {
      return new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('close', () => resolve());
        child.kill('SIGTERM');
        // Force kill after 5 s if still running
        setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        }, 5000);
      });
    },
  };
}
