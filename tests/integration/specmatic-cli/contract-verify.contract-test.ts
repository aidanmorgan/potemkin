/**
 * contract-verify.contract-test.ts
 *
 * Goal: Run `specmatic test` (the Specmatic CLI contract-test runner) against
 * our live engine and assert the CLI exits with code 0 (= all scenarios pass).
 *
 * Strategy (multi-process):
 *  1. Boot our engine on a random free port using `app.listen(0)`.
 *  2. Spawn `java -jar specmatic.jar test --testBaseURL=http://127.0.0.1:<port>
 *     ./fixtures/banking.yaml` as a child process.
 *  3. Capture stdout + stderr; assert exit code 0 and no FAILED lines.
 *
 * The banking.yaml fixture covers only GET /customers (list), which the engine
 * always handles correctly because it seeds two customers at boot.  Specmatic
 * generates both a query-param variant and a plain GET; both return HTTP 200.
 *
 * Java requirement:
 *  If `java` is not on PATH, the describe block is skipped gracefully.
 */

import * as http from 'node:http';
import * as path from 'node:path';
import type { Server } from 'node:http';

import { bootSystem } from '../../../src/engine/boot.js';
import { createGateway } from '../../../src/http/gateway.js';
import { loadBankingFixture } from '../_helpers/inline-fixture.js';
import {
  javaAvailable,
  ensureSpecmaticJar,
  runSpecmatic,
  SPECMATIC_VERSION,
} from './_helpers/specmatic-binary.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function startEngine(): Promise<{ server: Server; port: number }> {
  const fixture = await loadBankingFixture();
  const sys = await bootSystem(fixture);
  const app = createGateway(sys);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr !== 'object') {
        reject(new Error('Could not determine server address'));
        return;
      }
      resolve({ server, port: addr.port });
    });
    server.on('error', reject);
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// ---------------------------------------------------------------------------
// Skip guard
// ---------------------------------------------------------------------------

let _skipReason: string | undefined;

beforeAll(async () => {
  const hasJava = await javaAvailable();
  if (!hasJava) {
    _skipReason = 'Java not found on PATH; Specmatic CLI tests skipped';
    console.warn(`\n[contract-verify] ${_skipReason}\n`);
    return;
  }

  // Pre-warm: ensure jar is cached before the test starts its timer
  try {
    await ensureSpecmaticJar();
  } catch (err) {
    _skipReason = `Could not download Specmatic jar (network unavailable?): ${String(err)}`;
    console.warn(`\n[contract-verify] ${_skipReason}\n`);
  }
}, 120_000);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('contract-verify: Specmatic CLI test command against live engine', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    if (_skipReason) return;
    ({ server, port } = await startEngine());
  }, 30_000);

  afterAll(async () => {
    if (server) await stopServer(server);
  });

  it('specmatic test exits with code 0 (all contract scenarios pass)', async () => {
    if (_skipReason) {
      console.warn(`SKIP: ${_skipReason}`);
      return;
    }

    /**
     * Run: java -jar specmatic.jar test \
     *        --testBaseURL=http://127.0.0.1:<port> \
     *        --timeout=10 \
     *        ./fixtures/banking.yaml
     *
     * The banking.yaml fixture only covers GET /customers, which the engine
     * handles by returning the two seeded customers.  Both generated scenarios
     * (with and without query params) expect HTTP 200 and pass.
     *
     * Specmatic v2.x prints warnings about config not found — these are
     * harmless and we only assert the final exit code.
     */
    const fixturesDir = path.join(__dirname, 'fixtures');
    const contractPath = path.join(fixturesDir, 'banking.yaml');

    const result = await runSpecmatic(
      [
        'test',
        `--testBaseURL=http://127.0.0.1:${port}`,
        '--timeout=10',
        contractPath,
      ],
      // cwd: worktree root so Specmatic can write its build/reports output
      path.join(__dirname, '../../..'),
    );

    // Log output only on failure to keep CI logs clean
    if (result.exitCode !== 0) {
      console.error('[contract-verify] specmatic test stdout:\n', result.stdout);
      console.error('[contract-verify] specmatic test stderr:\n', result.stderr);
    }

    expect(result.exitCode).toBe(0);
  }, 120_000);

  it('specmatic test output contains no FAILED scenarios', async () => {
    if (_skipReason) {
      console.warn(`SKIP: ${_skipReason}`);
      return;
    }

    const fixturesDir = path.join(__dirname, 'fixtures');
    const contractPath = path.join(fixturesDir, 'banking.yaml');

    const result = await runSpecmatic(
      [
        'test',
        `--testBaseURL=http://127.0.0.1:${port}`,
        '--timeout=10',
        contractPath,
      ],
      path.join(__dirname, '../../..'),
    );

    // Extract failure lines (case-insensitive)
    const failLines = (result.stdout + result.stderr)
      .split('\n')
      .filter((l) => /has FAILED/i.test(l));

    if (failLines.length > 0) {
      console.error('[contract-verify] Failure lines:\n', failLines.join('\n'));
    }

    expect(failLines).toHaveLength(0);
  }, 120_000);

  it('specmatic test output contains at least one SUCCEEDED scenario', async () => {
    if (_skipReason) {
      console.warn(`SKIP: ${_skipReason}`);
      return;
    }

    const fixturesDir = path.join(__dirname, 'fixtures');
    const contractPath = path.join(fixturesDir, 'banking.yaml');

    const result = await runSpecmatic(
      [
        'test',
        `--testBaseURL=http://127.0.0.1:${port}`,
        '--timeout=10',
        contractPath,
      ],
      path.join(__dirname, '../../..'),
    );

    const succeededLines = (result.stdout + result.stderr)
      .split('\n')
      .filter((l) => /has SUCCEEDED/i.test(l));

    expect(succeededLines.length).toBeGreaterThan(0);
  }, 120_000);

  it(`specmatic version in output matches pinned version ${SPECMATIC_VERSION}`, async () => {
    if (_skipReason) {
      console.warn(`SKIP: ${_skipReason}`);
      return;
    }

    const result = await runSpecmatic(['--version']);
    const combined = result.stdout + result.stderr;

    // Specmatic prints: "Specmatic Version: vX.Y.Z" or "X.Y.Z"
    expect(combined).toMatch(new RegExp(SPECMATIC_VERSION.replace('.', '\\.'), 'i'));
  }, 30_000);
});
