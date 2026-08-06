/**
 * Conformance binaries — downloads + caches the Specmatic JAR and ensures the
 * plugin fat-JAR is built.
 *
 * Functions:
 *   ensureSpecmaticJar(version?) — returns absolute path to specmatic.jar
 *   ensurePluginJar()             — returns absolute path to plugin shadowJar
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { execSync, spawnSync } from 'node:child_process';

const CACHE_DIR = path.resolve(__dirname, '..', '..', '.cache');
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', 'plugin');
const PLUGIN_JAR_PATH = path.join(PLUGIN_ROOT, 'build', 'libs', 'potemkin-stateful-plugin.jar');
const DOWNLOAD_TIMEOUT_MS = 30_000;

const pendingDownloads = new Map<string, Promise<void>>();

interface DownloadOptions {
  readonly timeoutMs?: number;
  /** Expected SHA-256 digest of the downloaded artifact, in hexadecimal form. */
  readonly expectedSha256?: string;
}

const SPECMATIC_SHA256_BY_VERSION: Readonly<Record<string, string>> = {
  '2.46.2': '209bb1c7b14f9976eccf6bc3f94b31296cba852115c9c086640ed6d744b0fc29',
};

// ---------------------------------------------------------------------------
// Java availability check
// ---------------------------------------------------------------------------

export function javaAvailable(): boolean {
  try {
    execSync('java -version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Specmatic JAR download
// ---------------------------------------------------------------------------

export async function downloadFile(
  downloadUrl: string,
  dest: string,
  { timeoutMs = DOWNLOAD_TIMEOUT_MS, expectedSha256 }: DownloadOptions = {},
): Promise<void> {
  const initialUrl = new URL(downloadUrl);
  assertSupportedProtocol(initialUrl);

  const temporaryDirectory = await fsp.mkdtemp(
    path.join(path.dirname(dest), '.potemkin-download-'),
  );
  const temporaryPath = path.join(temporaryDirectory, path.basename(dest));

  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    let currentUrl = initialUrl.href;
    let response: Response;

    try {
      for (;;) {
        response = await fetch(currentUrl, {
          // Manual redirect handling preserves the previous behavior for all
          // 3xx responses with a Location header, including 300 and 305.
          redirect: 'manual',
          signal: timeout,
        });

        const location = response.headers.get('location');
        if (response.status >= 300 && response.status < 400 && location !== null) {
          await response.body?.cancel();
          const nextUrl = new URL(location, currentUrl);
          assertSupportedProtocol(nextUrl);
          currentUrl = nextUrl.href;
          continue;
        }
        break;
      }
    } catch (error) {
      if (timeout.aborted) {
        throw new Error(`Download timed out after ${timeoutMs} ms from ${downloadUrl}`, {
          cause: error,
        });
      }
      throw error;
    }

    const responseUrl = response.url || currentUrl;
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`Download failed: HTTP ${response.status} from ${responseUrl}`);
    }

    if (!response.body) {
      throw new Error(`Download failed: response body was empty from ${responseUrl}`);
    }

    try {
      await response.body.pipeTo(
        Writable.toWeb(fs.createWriteStream(temporaryPath, { flags: 'wx' })),
      );
    } catch (error) {
      if (timeout.aborted) {
        throw new Error(`Download timed out after ${timeoutMs} ms from ${downloadUrl}`, {
          cause: error,
        });
      }
      throw error;
    }

    await fsp.rename(temporaryPath, dest);
    if (expectedSha256 !== undefined && !(await hasSha256(dest, expectedSha256))) {
      await fsp.rm(dest, { force: true });
      throw new Error(`Downloaded artifact failed SHA-256 verification: ${downloadUrl}`);
    }
  } finally {
    await fsp.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function hasSha256(filePath: string, expectedSha256: string): Promise<boolean> {
  const normalized = expectedSha256.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`Expected SHA-256 digest must contain exactly 64 hexadecimal characters`);
  }
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex') === normalized;
}

function assertSupportedProtocol(target: URL): void {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`Unsupported download protocol: ${target.protocol}`);
  }
}

export async function ensureSpecmaticJar(
  version = '2.46.2',
  expectedSha256 = SPECMATIC_SHA256_BY_VERSION[version],
): Promise<string> {
  if (!javaAvailable()) {
    throw new Error('Java is not available on PATH — cannot run Specmatic');
  }

  if (expectedSha256 === undefined) {
    throw new Error(
      `No pinned SHA-256 digest is configured for Specmatic ${version}; pass expectedSha256 explicitly`,
    );
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const jarPath = path.join(CACHE_DIR, `specmatic-${version}.jar`);

  if (fs.existsSync(jarPath)) {
    if (await hasSha256(jarPath, expectedSha256)) return jarPath;
    await fsp.rm(jarPath, { force: true });
  }

  const pending = pendingDownloads.get(jarPath);
  if (pending) {
    await pending;
    return jarPath;
  }

  const downloadUrl = `https://github.com/specmatic/specmatic/releases/download/${version}/specmatic.jar`;
  const download = (async () => {
    console.log(`[potemkin-conformance] Downloading Specmatic ${version} from ${downloadUrl}…`);
    await downloadFile(downloadUrl, jarPath, { expectedSha256 });
    console.log(
      `[potemkin-conformance] Specmatic JAR cached at ${jarPath} (${fs.statSync(jarPath).size} bytes)`,
    );
  })();
  pendingDownloads.set(jarPath, download);

  try {
    await download;
    return jarPath;
  } finally {
    if (pendingDownloads.get(jarPath) === download) {
      pendingDownloads.delete(jarPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin JAR build
// ---------------------------------------------------------------------------

export async function ensurePluginJar(): Promise<string> {
  if (!javaAvailable()) {
    throw new Error('Java is not available on PATH — cannot build the plugin JAR');
  }

  if (fs.existsSync(PLUGIN_JAR_PATH)) {
    return PLUGIN_JAR_PATH;
  }

  console.log('[potemkin-conformance] Building plugin shadowJar…');
  const gradleCmd = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
  const result = spawnSync(gradleCmd, ['shadowJar', '--no-daemon'], {
    cwd: PLUGIN_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    throw new Error(`Gradle shadowJar failed with exit code ${result.status}`);
  }

  if (!fs.existsSync(PLUGIN_JAR_PATH)) {
    throw new Error(`Expected plugin JAR at ${PLUGIN_JAR_PATH} after build but file not found`);
  }

  console.log(
    `[potemkin-conformance] Plugin JAR built at ${PLUGIN_JAR_PATH} (${fs.statSync(PLUGIN_JAR_PATH).size} bytes)`,
  );
  return PLUGIN_JAR_PATH;
}
