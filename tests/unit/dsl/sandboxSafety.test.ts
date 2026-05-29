import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { scanTypescriptReducers } from '../../../src/dsl/typescriptScanner.js';
import { registry } from '../../../src/sdk/index.js';

async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-sandbox-safety-'));
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

describe('typescriptScanner sandbox — runtime safety', () => {
  it('process is not accessible from a reducer file', async () => {
    const root = await makeTree({
      'src/r/bad.ts': `process.exit(1);`,
    });
    await expect(
      scanTypescriptReducers({ scan: [{ include: ['src/r/**/*.ts'] }] }, { cwd: root }),
    ).rejects.toThrow();
  });

  it('console.log at module load is silently swallowed', async () => {
    const root = await makeTree({
      'src/r/ok.ts': `
        console.log('this should not throw');
        require('@potemkin/sdk').reducer({ boundary: 'X', event: 'Y' }, () => []);
      `,
    });
    const result = await scanTypescriptReducers(
      { scan: [{ include: ['src/r/**/*.ts'] }] },
      { cwd: root },
    );
    expect(result.registered.length).toBe(1);
  });
});
