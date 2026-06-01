import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { scanTypescriptReducers } from '../../../src/dsl/typescriptScanner';
import { registry } from '../../../src/sdk/index';
import { BootError } from '../../../src/errors';

// A scanned TS reducer that mutates process.env is rejected at scan time with
// SANDBOX_ERR_ENV_MUTATION (assertNoEnvMutation runs on the transpiled source
// before sandbox execution). `process` is also absent from the sandbox, so the
// host environment is never mutated regardless.

async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-env-mutation-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  return root;
}

async function scanExpectingError(source: string): Promise<BootError | null> {
  const root = await makeTree({ 'src/r/bad.ts': source });
  try {
    await scanTypescriptReducers({ scan: [{ include: ['src/r/**/*.ts'] }] }, { cwd: root });
    return null;
  } catch (e) {
    return e instanceof BootError ? e : null;
  }
}

beforeEach(async () => {
  await registry.reset();
});

describe('typescriptScanner sandbox — process.env mutation', () => {
  it.each([
    ["process.env.SECRET = 'leaked';", 'member assignment'],
    ["process.env['SECRET'] = 'leaked';", 'computed assignment'],
    ['process.env.COUNT += 1;', 'compound assignment'],
    ['delete process.env.PATH;', 'delete'],
    ["Object.assign(process.env, { HACKED: '1' });", 'Object.assign'],
  ])('rejects %s with SANDBOX_ERR_ENV_MUTATION (%s)', async (source) => {
    const err = await scanExpectingError(source);
    expect(err).toBeInstanceOf(BootError);
    expect(err?.code).toBe('SANDBOX_ERR_ENV_MUTATION');
    expect(err?.message).toMatch(/process\.env/);
  });

  it('the host process.env is not mutated by a scanned file (isolation holds)', async () => {
    const sentinel = '__POTEMKIN_ENV_MUTATION_SENTINEL__';
    expect(process.env[sentinel]).toBeUndefined();
    const err = await scanExpectingError(`process.env['${sentinel}'] = 'x';`);
    expect(err?.code).toBe('SANDBOX_ERR_ENV_MUTATION');
    expect(process.env[sentinel]).toBeUndefined();
  });

  it('a reducer that merely READS process.env is not flagged by the mutation detector', async () => {
    // A read isn't a mutation; the static detector ignores it. (It still fails
    // at sandbox load because `process` is absent — a transpile/load error — but
    // NOT the env-mutation code, proving the detector targets writes only.)
    const err = await scanExpectingError('export const x = process.env.HOME;');
    expect(err?.code).not.toBe('SANDBOX_ERR_ENV_MUTATION');
    expect(err?.code).toBe('BOOT_ERR_TS_TRANSPILE');
  });
});
