import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { scanTypescriptReducers } from '../../../src/dsl/typescriptScanner.js';
import { registry, scriptRegistry } from '../../../src/sdk/index.js';
import { BootError } from '../../../src/errors.js';

async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-ts-scan-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  return root;
}

beforeEach(async () => {
  await registry.reset();
  scriptRegistry.resetSync();
});

describe('typescriptScanner — discovers and loads .ts reducer files', () => {
  it('matches files across multiple include globs and registers reducers', async () => {
    const root = await makeTree({
      'src/reducers/lead.ts': `
        const { reducer, replace } = require('@potemkin/sdk');
        reducer({ boundary: 'Lead', event: 'LeadCreated' }, () => [replace('/id', 'x')]);
      `,
      'src/behaviors/opp.ts': `
        const { reducer } = require('@potemkin/sdk');
        reducer({ boundary: 'Opportunity', event: 'OpportunityWon' }, () => []);
      `,
    });
    const result = await scanTypescriptReducers(
      {
        scan: [
          { include: ['src/reducers/**/*.ts'] },
          { include: ['src/behaviors/**/*.ts'] },
        ],
      },
      { cwd: root },
    );
    expect(result.files.length).toBe(2);
    expect(result.registered.length).toBe(2);
    expect(registry.get({ boundary: 'Lead', event: 'LeadCreated' })).toBeDefined();
    expect(registry.get({ boundary: 'Opportunity', event: 'OpportunityWon' })).toBeDefined();
  });

  it('respects exclude globs', async () => {
    const root = await makeTree({
      'src/reducers/a.ts': `require('@potemkin/sdk').reducer({ boundary: 'A', event: 'E' }, () => []);`,
      'src/reducers/a.test.ts': `throw new Error('this file should be excluded');`,
    });
    const result = await scanTypescriptReducers(
      {
        scan: [
          { include: ['src/reducers/**/*.ts'], exclude: ['**/*.test.ts'] },
        ],
      },
      { cwd: root },
    );
    expect(result.files.length).toBe(1);
  });
});

describe('typescriptScanner — sandbox require-hook', () => {
  it('resolves @potemkin/sdk to the in-tree SDK', async () => {
    const root = await makeTree({
      'src/r/a.ts': `
        const sdk = require('@potemkin/sdk');
        if (typeof sdk.reducer !== 'function') throw new Error('sdk.reducer missing');
        if (typeof sdk.replace !== 'function') throw new Error('sdk.replace missing');
        sdk.reducer({ boundary: 'X', event: 'Y' }, () => []);
      `,
    });
    const result = await scanTypescriptReducers(
      { scan: [{ include: ['src/r/**/*.ts'] }] },
      { cwd: root },
    );
    expect(result.registered.length).toBe(1);
  });

  it('allows sibling .ts imports inside the same scan directory', async () => {
    const root = await makeTree({
      'src/r/shared.ts': `module.exports = { CONST: 42 };`,
      'src/r/main.ts': `
        const { CONST } = require('./shared');
        if (CONST !== 42) throw new Error('shared not loaded');
        require('@potemkin/sdk').reducer({ boundary: 'X', event: 'Y' }, () => []);
      `,
    });
    const result = await scanTypescriptReducers(
      { scan: [{ include: ['src/r/**/*.ts'] }] },
      { cwd: root },
    );
    expect(result.registered.length).toBe(1);
  });

  it('rejects non-relative imports other than @potemkin/sdk', async () => {
    const root = await makeTree({
      'src/r/bad.ts': `require('lodash');`,
    });
    let caught: BootError | null = null;
    try {
      await scanTypescriptReducers(
        { scan: [{ include: ['src/r/**/*.ts'] }] },
        { cwd: root },
      );
    } catch (e) {
      if (e instanceof BootError) caught = e;
    }
    expect(caught?.code).toBe('SANDBOX_ERR_FORBIDDEN_IMPORT');
  });

  it('rejects fs/net/process imports', async () => {
    const root = await makeTree({
      'src/r/bad.ts': `require('fs');`,
    });
    let caught: BootError | null = null;
    try {
      await scanTypescriptReducers(
        { scan: [{ include: ['src/r/**/*.ts'] }] },
        { cwd: root },
      );
    } catch (e) {
      if (e instanceof BootError) caught = e;
    }
    expect(caught?.code).toBe('SANDBOX_ERR_FORBIDDEN_IMPORT');
  });
});

describe('typescriptScanner — per-scan module isolation', () => {
  it('a second scan of the same path sees new content, not a stale cached module', async () => {
    const root = await makeTree({
      'src/r/shared.ts': `module.exports = { boundary: 'First', event: 'FirstEvent' };`,
      'src/r/main.ts': `
        const meta = require('./shared');
        require('@potemkin/sdk').reducer(meta, () => []);
      `,
    });

    const first = await scanTypescriptReducers(
      { scan: [{ include: ['src/r/**/*.ts'] }] },
      { cwd: root },
    );
    expect(first.registered.length).toBe(1);
    expect(registry.get({ boundary: 'First', event: 'FirstEvent' })).toBeDefined();

    // Rewrite the imported sibling at the SAME path with DIFFERENT content.
    await fs.writeFile(
      path.join(root, 'src/r/shared.ts'),
      `module.exports = { boundary: 'Second', event: 'SecondEvent' };`,
      'utf8',
    );

    const second = await scanTypescriptReducers(
      { scan: [{ include: ['src/r/**/*.ts'] }] },
      { cwd: root },
    );
    expect(second.registered.length).toBe(1);
    // With a shared module cache the second scan would re-use the stale `First`
    // export and register the old metadata; per-scan isolation re-reads the
    // file and registers the new metadata.
    expect(registry.get({ boundary: 'Second', event: 'SecondEvent' })).toBeDefined();
    expect(registry.get({ boundary: 'First', event: 'FirstEvent' })).toBeUndefined();
  });
});

describe('typescriptScanner — transpile errors', () => {
  it('throws BOOT_ERR_TS_TRANSPILE when a file fails to parse', async () => {
    const root = await makeTree({
      'src/r/bad.ts': `this is not valid typescript ::`,
    });
    let caught: BootError | null = null;
    try {
      await scanTypescriptReducers(
        { scan: [{ include: ['src/r/**/*.ts'] }] },
        { cwd: root },
      );
    } catch (e) {
      if (e instanceof BootError) caught = e;
    }
    expect(caught?.code).toBe('BOOT_ERR_TS_TRANSPILE');
  });
});

describe('typescriptScanner — script registry drained alongside reducers', () => {
  it('drains @Script-registered scripts into result.scripts', async () => {
    const root = await makeTree({
      'src/r/score.ts': `
        const sdk = require('@potemkin/sdk');
        sdk.Script('computeScore')(
          class ComputeScore {
            run(ctx) {
              const base = { REFERRAL: 80, WEBSITE: 50 };
              return base[ctx.command.payload.source] ?? 30;
            }
          }
        );
      `,
    });
    const result = await scanTypescriptReducers(
      { scan: [{ include: ['src/r/**/*.ts'] }] },
      { cwd: root },
    );
    expect(result.scripts.length).toBe(1);
    expect(result.scripts[0].id).toBe('computeScore');
    expect(typeof result.scripts[0].fn).toBe('function');
  });

  it('drains defineScript-registered scripts into result.scripts', async () => {
    const root = await makeTree({
      'src/r/helper.ts': `
        const sdk = require('@potemkin/sdk');
        sdk.defineScript('riskScore', function(ctx) { return 99; });
      `,
    });
    const result = await scanTypescriptReducers(
      { scan: [{ include: ['src/r/**/*.ts'] }] },
      { cwd: root },
    );
    expect(result.scripts.length).toBe(1);
    expect(result.scripts[0].id).toBe('riskScore');
  });

  it('resets the script registry between successive scans', async () => {
    const root = await makeTree({
      'src/r/a.ts': `
        require('@potemkin/sdk').defineScript('scriptA', function() { return 1; });
      `,
    });
    const first = await scanTypescriptReducers(
      { scan: [{ include: ['src/r/**/*.ts'] }] },
      { cwd: root },
    );
    expect(first.scripts.length).toBe(1);

    // Second scan of the same tree — scriptA must appear exactly once
    // (not duplicated from a stale registry state).
    const second = await scanTypescriptReducers(
      { scan: [{ include: ['src/r/**/*.ts'] }] },
      { cwd: root },
    );
    expect(second.scripts.length).toBe(1);
    expect(second.scripts[0].id).toBe('scriptA');
  });

  it('result.scripts is empty when no scripts are declared in scanned files', async () => {
    const root = await makeTree({
      'src/r/reducerOnly.ts': `
        require('@potemkin/sdk').reducer({ boundary: 'A', event: 'E' }, () => []);
      `,
    });
    const result = await scanTypescriptReducers(
      { scan: [{ include: ['src/r/**/*.ts'] }] },
      { cwd: root },
    );
    expect(result.registered.length).toBe(1);
    expect(result.scripts.length).toBe(0);
  });
});
