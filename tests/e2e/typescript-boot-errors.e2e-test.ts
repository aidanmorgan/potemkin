import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startE2eApp } from './_harness/e2e-test-app';

describe('E2E-024 TypeScript factory boot failure', () => {
  it('rejects a duplicate factory registration through the real scanner', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'potemkin-ts-boot-'));
    fs.cpSync(path.resolve('tests/fixtures/configured-stack'), root, { recursive: true });
    const source = path.join(root, 'typescript/factory/duplicate.ts');
    fs.writeFileSync(
      source,
      fs.readFileSync(path.join(root, 'typescript/factory/widget.ts'), 'utf8'),
    );
    await expect(
      startE2eApp({
        potemkinConfigPath: path.join(root, 'potemkin-factory.yml'),
        warmupPath: '/widgets/missing',
        warmupExpectedStatus: 404,
      }),
    ).rejects.toThrow();
    fs.rmSync(root, { recursive: true, force: true });
  }, 120_000);
});
