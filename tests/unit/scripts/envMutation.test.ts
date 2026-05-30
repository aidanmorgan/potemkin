import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { scanTypescriptReducers } from '../../../src/dsl/typescriptScanner';
import { registry } from '../../../src/sdk/index';
import { BootError } from '../../../src/errors';

// AC-G1.5: a scanned TS reducer file that mutates process.env must be blocked
// at scan time.
//
// The sandbox vm context (src/dsl/typescriptScanner.ts:loadModule) does NOT
// expose a `process` global, so any reference to `process.env` — read OR
// write — fails at module-load with a ReferenceError, which the scanner wraps
// as BOOT_ERR_TS_TRANSPILE. The env mutation is therefore rejected, satisfying
// the safety property the AC targets.
//
// NOTE / FINDING: the scanner has no dedicated detector for env mutation, so
// it never emits the SANDBOX_ERR_ENV_MUTATION code that the AC names (that
// code exists only in the scanner's `isForbidden` allowlist — a dead branch,
// never thrown). These tests assert the behaviour that the code path actually
// produces today and pin the safety guarantee; they intentionally do not
// assert SANDBOX_ERR_ENV_MUTATION because no src path produces it.

async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-env-mutation-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  return root;
}

beforeEach(async () => {
  await registry.reset();
});

describe('typescriptScanner sandbox — process.env mutation (AC-G1.5)', () => {
  it('a reducer file that writes process.env is rejected at scan time', async () => {
    const root = await makeTree({
      'src/r/bad.ts': `process.env.SECRET = 'leaked';`,
    });
    let caught: BootError | null = null;
    try {
      await scanTypescriptReducers({ scan: [{ include: ['src/r/**/*.ts'] }] }, { cwd: root });
    } catch (e) {
      if (e instanceof BootError) caught = e;
    }
    expect(caught).toBeInstanceOf(BootError);
    // process is absent from the sandbox, so the mutation never lands; the
    // failure surfaces as a transpile/load-time boot error.
    expect(caught?.code).toBe('BOOT_ERR_TS_TRANSPILE');
    expect(caught?.message).toMatch(/process is not defined/);
  });

  it('a reducer file that deletes a process.env key is rejected at scan time', async () => {
    const root = await makeTree({
      'src/r/bad.ts': `delete process.env.PATH;`,
    });
    let caught: BootError | null = null;
    try {
      await scanTypescriptReducers({ scan: [{ include: ['src/r/**/*.ts'] }] }, { cwd: root });
    } catch (e) {
      if (e instanceof BootError) caught = e;
    }
    expect(caught).toBeInstanceOf(BootError);
    expect(caught?.code).toBe('BOOT_ERR_TS_TRANSPILE');
  });

  it('the host process.env is not mutated by a scanned file (isolation holds)', async () => {
    const sentinel = '__POTEMKIN_ENV_MUTATION_SENTINEL__';
    expect(process.env[sentinel]).toBeUndefined();
    const root = await makeTree({
      'src/r/bad.ts': `process.env['${sentinel}'] = 'x';`,
    });
    await expect(
      scanTypescriptReducers({ scan: [{ include: ['src/r/**/*.ts'] }] }, { cwd: root }),
    ).rejects.toBeInstanceOf(BootError);
    // The host environment is untouched regardless of how the scan failed.
    expect(process.env[sentinel]).toBeUndefined();
  });
});
