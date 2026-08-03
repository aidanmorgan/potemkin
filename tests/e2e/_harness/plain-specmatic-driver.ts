/**
 * Specmatic-only mock driver.
 *
 * This deliberately launches a separate JVM with only the Specmatic JAR. It
 * does not add the Potemkin plugin to a classpath and it does not boot a
 * Potemkin engine. The exported examples are the complete source of the
 * responses served by this process.
 */

import * as cp from "node:child_process";
import * as http from "node:http";
import { getFreePort } from "../../../src/conformance/portAllocator.js";

export interface PlainSpecmaticOptions {
  readonly contractPath: string;
  readonly examplesDir: string;
  readonly specmaticJar: string;
  readonly stubPort?: number;
  readonly extraEnv?: Record<string, string>;
}

export interface PlainSpecmaticHandle {
  readonly stubPort: number;
  readonly url: string;
  readonly process: cp.ChildProcess;
  /** The exact JVM arguments, useful for asserting this is a plain mock. */
  readonly launchArgs: readonly string[];
  ready(): Promise<void>;
  shutdown(): Promise<void>;
}

async function probeUntilUp(targetUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const available = await new Promise<boolean>((resolve) => {
      const request = http.get(targetUrl, (response) => {
        response.resume();
        resolve(true);
      });
      request.on("error", () => resolve(false));
      request.setTimeout(1_000, () => {
        request.destroy();
        resolve(false);
      });
    });
    if (available) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Plain Specmatic stub at ${targetUrl} did not become ready`);
}

export async function startPlainSpecmatic(
  options: PlainSpecmaticOptions,
): Promise<PlainSpecmaticHandle> {
  const stubPort = options.stubPort ?? (await getFreePort());
  const launchArgs = [
    "-Xmx512m",
    "-XX:+UseSerialGC",
    "-jar",
    options.specmaticJar,
    "stub",
    "--port",
    String(stubPort),
    "--data",
    options.examplesDir,
    options.contractPath,
  ];
  const child = cp.spawn("java", launchArgs, {
    env: { ...process.env, ...options.extraEnv },
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();

  let readyPromise: Promise<void> | undefined;
  const url = `http://127.0.0.1:${stubPort}`;
  const handle: PlainSpecmaticHandle = {
    stubPort,
    url,
    process: child,
    launchArgs,
    ready: async () => {
      readyPromise ??= probeUntilUp(`${url}/`, 60_000);
      await readyPromise;
    },
    shutdown: async () => {
      if (child.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGTERM");
      });
    },
  };
  return handle;
}
