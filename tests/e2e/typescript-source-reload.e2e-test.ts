import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startE2eApp, type E2eApp } from './_harness/e2e-test-app';
import { requestThroughSpecmatic } from './_harness/e2e-coverage-helpers';

describe('E2E-021 TypeScript source reload', () => {
  let app: E2eApp;
  let root: string;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'potemkin-ts-reload-'));
    fs.cpSync(path.resolve('tests/fixtures/configured-stack'), root, { recursive: true });
    const config = path.join(root, 'potemkin-typescript.yml');
    fs.writeFileSync(
      config,
      fs
        .readFileSync(config, 'utf8')
        .replace('typescript:\n', 'typescript:\n  watchIntervalMs: 100\n'),
    );
    app = await startE2eApp({
      potemkinConfigPath: config,
      warmupPath: '/widgets/not-created',
      warmupExpectedStatus: 404,
    });
  }, 180_000);
  afterAll(async () => {
    await app?.shutdown();
    // The E2E harness may share its watcher with later suites. Move that
    // watcher back to a repository-owned fixture before removing this suite's
    // temporary source tree.
    const stable = await startE2eApp({
      potemkinConfigPath: path.resolve('tests/fixtures/configured-stack/potemkin-yaml.yml'),
      warmupPath: '/things/not-created',
      warmupExpectedStatus: 404,
    });
    await stable.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }, 30_000);

  it('observes a changed scanned TypeScript source through the same Specmatic JVM', async () => {
    const before = await requestThroughSpecmatic(app.stubUrl, 'POST', '/widgets', {
      name: 'before-reload',
    });
    expect(before.status).toBe(201);
    const specmaticPid = app.specmatic.process.pid;
    const source = path.join(root, 'typescript/widget/widget.ts');
    fs.writeFileSync(
      source,
      fs
        .readFileSync(source, 'utf8')
        .replace("sourceLabel('typescript')", "sourceLabel('typescript-reloaded')"),
    );
    await fetch(`${app.engineUrl}/_admin/force-reload`, { method: 'POST' });
    const after = await requestThroughSpecmatic(app.stubUrl, 'POST', '/widgets', {
      name: 'after-reload',
    });
    expect(after.status).toBe(201);
    expect((after.body as Record<string, unknown>).source).toBe('typescript-reloaded');
    expect((after.body as Record<string, unknown>).id).not.toBe(
      (before.body as Record<string, unknown>).id,
    );
    expect(app.specmatic.process.pid).toBe(specmaticPid);
  }, 60_000);
});
