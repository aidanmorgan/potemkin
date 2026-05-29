import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { startTypescriptWatcher } from '../../../src/dsl/typescriptWatcher.js';
import { registry } from '../../../src/sdk/index.js';
import { BootError } from '../../../src/errors.js';

async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-ts-watch-'));
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

describe('typescriptWatcher — production guard', () => {
  it('throws when NODE_ENV=production', async () => {
    const prior = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    let caught: BootError | null = null;
    try {
      await startTypescriptWatcher({
        config: { scan: [{ include: ['*.ts'] }], watch: true },
        cwd: process.cwd(),
        onSwap: async () => {},
      });
    } catch (e) {
      if (e instanceof BootError) caught = e;
    } finally {
      if (prior === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = prior;
    }
    expect(caught?.code).toBe('BOOT_ERR_WATCH_IN_PRODUCTION');
  });
});

describe('typescriptWatcher — debounced rescan', () => {
  it('rescans after a file change and invokes onSwap with the new registry snapshot', async () => {
    const root = await makeTree({
      'src/r/a.ts': `require('@potemkin/sdk').reducer({ boundary: 'A', event: 'E1' }, () => []);`,
    });

    const swaps: number[] = [];
    const w = await startTypescriptWatcher({
      config: { scan: [{ include: ['src/r/**/*.ts'] }], watch: true, watchDebounceMs: 50 },
      cwd: root,
      onSwap: (r) => {
        swaps.push(r.registered.length);
      },
    });

    try {
      // Wait briefly so the watcher's stability-threshold has time to attach.
      await new Promise((r) => setTimeout(r, 100));
      await fs.writeFile(
        path.join(root, 'src/r/b.ts'),
        `require('@potemkin/sdk').reducer({ boundary: 'B', event: 'E2' }, () => []);`,
        'utf8',
      );
      // Poll for up to 3s for the rescan to fire.
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && swaps.length === 0) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(swaps.length).toBeGreaterThanOrEqual(1);
      expect(swaps[swaps.length - 1]).toBe(2);
    } finally {
      await w.stop();
    }
  });
});
