/**
 * Binary fetcher — downloads + caches the Specmatic JAR and ensures the
 * plugin fat-JAR is built.
 *
 * Functions:
 *   ensureSpecmaticJar(version?) — returns absolute path to specmatic.jar
 *   ensurePluginJar()             — returns absolute path to plugin shadowJar
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';
import * as url from 'node:url';
import { execSync, spawnSync } from 'node:child_process';

const CACHE_DIR = path.resolve(__dirname, '..', '.cache');
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..', 'plugin');
const PLUGIN_JAR_PATH = path.join(PLUGIN_ROOT, 'build', 'libs', 'potemkin-stateful-plugin.jar');

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

async function downloadFile(downloadUrl: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    function get(currentUrl: string): void {
      const parsed = new url.URL(currentUrl);
      const transport = parsed.protocol === 'https:' ? https : http;

      transport
        .get(currentUrl, (res) => {
          // Follow redirects (GitHub releases use redirects)
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            get(res.headers.location);
            res.resume();
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Download failed: HTTP ${res.statusCode} from ${currentUrl}`));
            res.resume();
            return;
          }

          const tmpPath = dest + '.tmp';
          const out = fs.createWriteStream(tmpPath);
          res.pipe(out);
          out.on('finish', () => {
            out.close(() => {
              fs.renameSync(tmpPath, dest);
              resolve();
            });
          });
          out.on('error', (err) => {
            fs.unlinkSync(tmpPath);
            reject(err);
          });
        })
        .on('error', reject);
    }

    get(downloadUrl);
  });
}

export async function ensureSpecmaticJar(version = '2.6.0'): Promise<string> {
  if (!javaAvailable()) {
    throw new Error('Java is not available on PATH — cannot run Specmatic');
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const jarPath = path.join(CACHE_DIR, `specmatic-${version}.jar`);

  if (fs.existsSync(jarPath)) {
    return jarPath;
  }

  const downloadUrl = `https://github.com/specmatic/specmatic/releases/download/${version}/specmatic.jar`;
  console.log(`[binary-fetcher] Downloading Specmatic ${version} from ${downloadUrl}…`);
  await downloadFile(downloadUrl, jarPath);
  console.log(`[binary-fetcher] Specmatic JAR cached at ${jarPath} (${fs.statSync(jarPath).size} bytes)`);
  return jarPath;
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

  console.log('[binary-fetcher] Building plugin shadowJar…');
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

  console.log(`[binary-fetcher] Plugin JAR built at ${PLUGIN_JAR_PATH} (${fs.statSync(PLUGIN_JAR_PATH).size} bytes)`);
  return PLUGIN_JAR_PATH;
}
