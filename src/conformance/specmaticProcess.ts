/**
 * Specmatic JVM driver — spawns a real Specmatic stub server process with the
 * plugin JAR on the classpath, waits for it to be ready, and provides a clean
 * shutdown helper.
 */

import * as cp from 'node:child_process';
import { getFreePort } from './portAllocator.js';

const READINESS_DIAGNOSTIC_LIMIT = 4_096;

export interface ReadinessProbeResult {
  readonly ready: boolean;
  readonly diagnostic?: string;
}

export interface ReadinessWaitOptions {
  readonly description: string;
  readonly timeoutMs: number;
  readonly attemptTimeoutMs: number;
  readonly intervalMs: number;
  readonly probe: (signal: AbortSignal) => Promise<ReadinessProbeResult>;
  /** Abort the whole wait, rather than merely timing out the current probe. */
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly timeoutSignal?: (milliseconds: number) => AbortSignal;
}

/** A readiness condition cannot succeed because its owned resource has stopped. */
export class ReadinessAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadinessAbortedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Poll a readiness condition with a strict overall deadline and per-attempt
 * cancellation. `async-retry` is intentionally not used here: its retry count
 * and backoff timers do not provide a wall-clock deadline or a way to stop when
 * the process being awaited has exited.
 */
export async function waitForReadiness(options: ReadinessWaitOptions): Promise<void> {
  if (options.timeoutMs < 0) throw new RangeError('Readiness timeout must be non-negative');
  if (options.attemptTimeoutMs <= 0)
    throw new RangeError('Readiness attempt timeout must be positive');
  if (options.intervalMs < 0) throw new RangeError('Readiness interval must be non-negative');

  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  const timeoutSignal =
    options.timeoutSignal ?? ((milliseconds: number) => AbortSignal.timeout(milliseconds));
  const deadline = now() + options.timeoutMs;
  let lastDiagnostic = 'no response';

  while (now() < deadline) {
    options.signal?.throwIfAborted();
    const remainingMs = deadline - now();
    const signal = timeoutSignal(Math.min(options.attemptTimeoutMs, remainingMs));
    const probeSignal =
      options.signal === undefined ? signal : AbortSignal.any([options.signal, signal]);
    try {
      const result = await options.probe(probeSignal);
      if (result.ready) return;
      lastDiagnostic = result.diagnostic ?? 'not ready';
    } catch (error) {
      if (error instanceof ReadinessAbortedError) throw error;
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      lastDiagnostic = errorMessage(error);
    }

    const delayMs = Math.min(options.intervalMs, deadline - now());
    if (delayMs > 0) {
      options.signal?.throwIfAborted();
      await sleep(delayMs);
    }
  }

  throw new Error(
    `${options.description} did not become ready within ${options.timeoutMs} ms (last: ${lastDiagnostic})`,
  );
}

export interface SpecmaticHandle {
  readonly stubPort: number;
  readonly process: cp.ChildProcess;
  shutdown(): Promise<void>;
  ready(signal?: AbortSignal): Promise<void>;
}

export interface SpecmaticOptions {
  /** OpenAPI YAML contract files loaded by this Specmatic JVM. */
  readonly contractPaths: readonly string[];
  /** Absolute path to the plugin fat-JAR. */
  readonly pluginJar: string;
  /** Absolute path to the specmatic.jar. */
  readonly specmaticJar: string;
  /** Stub port to bind.  Defaults to a free ephemeral port. */
  readonly stubPort?: number;
  /** Extra environment variables passed to the JVM process. */
  readonly extraEnv?: Record<string, string>;
  /** Optional cancellation signal for the startup readiness wait. */
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Start Specmatic
// ---------------------------------------------------------------------------

export async function startSpecmatic(opts: SpecmaticOptions): Promise<SpecmaticHandle> {
  const stubPort = opts.stubPort ?? (await getFreePort());
  const sep = process.platform === 'win32' ? ';' : ':';
  const classpath = `${opts.specmaticJar}${sep}${opts.pluginJar}`;

  const jvmArgs = [
    // Cap the heap so several Specmatic JVMs (serialised across e2e suites, or
    // running alongside another test process on the same host) cannot exhaust
    // machine memory — keeps stub startup reliable under contention.
    '-Xmx512m',
    '-XX:+UseSerialGC',
    '-cp',
    classpath,
    'application.SpecmaticApplication',
    'stub',
    '--port',
    String(stubPort),
    ...opts.contractPaths,
  ];

  const childEnv = {
    ...process.env,
    ...opts.extraEnv,
  };

  const child = cp.spawn('java', jvmArgs, {
    env: childEnv,
    // Keep stdout quiet, but retain a bounded stderr tail for startup failures.
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // The test worker owns this process for the duration of the run, but the
  // JVM must not keep Jest alive after the worker has finished. The worker's
  // exit handler performs the final SIGTERM cleanup.
  child.unref();

  let processError: Error | undefined;
  let stderrTail = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string | Buffer) => {
    stderrTail = `${stderrTail}${typeof chunk === 'string' ? chunk : chunk.toString('utf8')}`.slice(
      -READINESS_DIAGNOSTIC_LIMIT,
    );
  });
  child.on('error', (err) => {
    processError = err;
    process.stderr.write(`[specmatic] Process error: ${err.message}\n`);
  });

  // ---- Handle object -------------------------------------------------------

  let readyPromise: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const targetUrl = `http://127.0.0.1:${stubPort}/`;
  const processDiagnostic = (): string => {
    const details = stderrTail.trim();
    return details.length === 0 ? '' : `; stderr: ${details}`;
  };

  const processReadinessFailure = (): ReadinessAbortedError | undefined => {
    if (processError)
      return new ReadinessAbortedError(
        `Specmatic process failed to start: ${processError.message}${processDiagnostic()}`,
      );
    if (child.exitCode !== null)
      return new ReadinessAbortedError(
        `Specmatic process exited with code ${child.exitCode}${processDiagnostic()}`,
      );
    if (child.signalCode !== null)
      return new ReadinessAbortedError(
        `Specmatic process exited due to ${child.signalCode}${processDiagnostic()}`,
      );
    return undefined;
  };

  const handle: SpecmaticHandle = {
    stubPort,
    process: child,

    async ready(signal?: AbortSignal) {
      const current =
        readyPromise ??
        (readyPromise = waitForReadiness({
          description: `Specmatic stub at ${targetUrl}`,
          timeoutMs: 60_000,
          attemptTimeoutMs: 1_000,
          intervalMs: 500,
          signal: signal ?? opts.signal,
          probe: async (signal) => {
            const failure = processReadinessFailure();
            if (failure) throw failure;

            // Specmatic doesn't expose /actuator/health — any HTTP response
            // (including 400) means that the server is up.
            const response = await fetch(targetUrl, { redirect: 'manual', signal });
            response.body?.cancel().catch(() => {
              /* ignore response cleanup errors */
            });
            return { ready: true, diagnostic: `HTTP ${response.status}` };
          },
        }));

      try {
        await current;
      } catch (error) {
        if (readyPromise === current) readyPromise = undefined;
        throw error;
      }
    },

    async shutdown() {
      shutdownPromise ??= new Promise<void>((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }

        let finished = false;
        let terminateTimer: ReturnType<typeof setTimeout> | undefined;
        let forceTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: Error): void => {
          if (finished) return;
          finished = true;
          if (terminateTimer) clearTimeout(terminateTimer);
          if (forceTimer) clearTimeout(forceTimer);
          if (error) reject(error);
          else resolve();
        };

        child.once('close', finish);
        terminateTimer = setTimeout(() => {
          if (child.exitCode !== null || child.signalCode !== null) {
            finish();
            return;
          }
          if (!child.kill('SIGKILL')) {
            finish(new Error('Specmatic process could not be forcefully terminated'));
            return;
          }
          forceTimer = setTimeout(() => {
            if (child.exitCode !== null || child.signalCode !== null) finish();
            else finish(new Error('Specmatic process did not exit after SIGKILL'));
          }, 1_000);
        }, 5_000);

        child.kill('SIGTERM');
      });
      return shutdownPromise;
    },
  };

  return handle;
}
