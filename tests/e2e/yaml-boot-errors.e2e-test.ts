import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startE2eApp } from './_harness/e2e-test-app';

describe('E2E-023 YAML declaration boot failure', () => {
  it('rejects an unknown YAML event reference before business traffic is accepted', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'potemkin-yaml-boot-'));
    fs.cpSync(path.resolve('tests/fixtures/audit-fields'), root, { recursive: true });
    const boundary = path.join(root, 'dsl/note.yaml');
    fs.writeFileSync(
      boundary,
      fs.readFileSync(boundary, 'utf8').replace('NoteCreated', 'UnknownEvent'),
    );
    await expect(
      startE2eApp({
        fixtureName: 'audit-fields',
        potemkinConfigPath: path.join(root, 'potemkin.yml'),
        warmupPath: '/notes/missing',
        warmupExpectedStatus: 404,
      }),
    ).rejects.toThrow();
    fs.rmSync(root, { recursive: true, force: true });
  }, 120_000);
});
