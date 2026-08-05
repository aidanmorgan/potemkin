/**
 * configured source matrix through the real Specmatic path.
 *
 * Each case boots a real Specmatic JVM, the real Potemkin plugin, and the Node
 * engine from exactly one potemkin configuration file. Every assertion sends
 * traffic to Specmatic's stub URL. The warm-up must observe an engine-specific 404
 * before the cases run, preventing a Specmatic-generated response from being
 * mistaken for a Potemkin result.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { startE2eApp } from './_harness/e2e-test-app';
import type { E2eApp } from './_harness/e2e-test-app';

const FIXTURE = path.resolve(process.cwd(), 'tests/fixtures/configured-stack');

const MODES = [
  {
    name: 'YAML',
    config: 'potemkin-yaml.yml',
    createPath: '/things',
    getPath: (id: string) => `/things/${id}`,
    source: 'yaml',
    warmupPath: '/things/not-created',
    modelAggregates: ['Thing'],
  },
  {
    name: 'TypeScript',
    config: 'potemkin-typescript.yml',
    createPath: '/widgets',
    getPath: (id: string) => `/widgets/${id}`,
    source: 'typescript',
    warmupPath: '/widgets/not-created',
    modelAggregates: ['Widget'],
  },
  {
    name: 'TypeScript static factory',
    config: 'potemkin-factory.yml',
    createPath: '/widgets',
    getPath: (id: string) => `/widgets/${id}`,
    source: 'typescript',
    warmupPath: '/widgets/not-created',
    modelAggregates: ['Widget'],
  },
  {
    name: 'YAML + TypeScript',
    config: 'potemkin-mixed.yml',
    createPath: '/things',
    getPath: (id: string) => `/things/${id}`,
    source: 'yaml',
    warmupPath: '/things/not-created',
    modelAggregates: ['Thing', 'Widget'],
  },
] as const;

describe.each(MODES)('$name configured stack', (mode) => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp({
      potemkinConfigPath: path.join(FIXTURE, mode.config),
      warmupPath: mode.warmupPath,
      warmupExpectedStatus: 404,
    });
    expect(app.stubForwardingHealthy).toBe(true);
  }, 180_000);

  afterAll(async () => {
    await app?.shutdown();
  }, 30_000);

  it('forwards the configured source behaviour through Specmatic and preserves state on a follow-up request', async () => {
    const modelResponse = await fetch(`${app.engineUrl}/_admin/model`);
    expect(modelResponse.status).toBe(200);
    const model = (await modelResponse.json()) as {
      schemaVersion: number;
      machines: readonly { aggregate: string }[];
    };
    expect(model.schemaVersion).toBe(1);
    expect(model.machines.map((machine) => machine.aggregate)).toEqual(mode.modelAggregates);

    const response = await fetch(`${app.stubUrl}${mode.createPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ name: `configured-${mode.name}` }),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string; name: string; source: string };
    expect(created).toEqual(
      expect.objectContaining({
        name: `configured-${mode.name}`,
        source: mode.source,
      }),
    );

    const getResponse = await fetch(`${app.stubUrl}${mode.getPath(created.id)}`, {
      headers: { Accept: 'application/json' },
    });
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toEqual(created);
  }, 60_000);

  it('returns the contract-shaped in-contract fallback through Specmatic', async () => {
    const response = await fetch(`${app.stubUrl}/unimplemented`, {
      headers: { Accept: 'application/json' },
    });

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({
      error: 'BOUNDARY_NOT_IMPLEMENTED',
      message: 'No runtime boundary for /unimplemented',
    });
  }, 60_000);

  if (mode.name === 'YAML + TypeScript') {
    it('composes a YAML dispatch into the TypeScript boundary through Specmatic', async () => {
      const response = await fetch(`${app.stubUrl}/things`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ name: 'cross-source-dispatch' }),
      });
      expect(response.status).toBe(201);
      const thing = (await response.json()) as { id: string; name: string; source: string };
      expect(thing.source).toBe('yaml');

      const widgetResponse = await fetch(`${app.stubUrl}/widgets/${thing.id}-widget`, {
        headers: { Accept: 'application/json' },
      });
      expect(widgetResponse.status).toBe(200);
      expect(await widgetResponse.json()).toEqual({
        id: `${thing.id}-widget`,
        name: 'cross-source-dispatch',
        source: 'typescript',
      });
    }, 60_000);

    it('also exposes the independently configured TypeScript operation through Specmatic', async () => {
      const response = await fetch(`${app.stubUrl}/widgets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ name: 'direct-typescript-operation' }),
      });
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual(
        expect.objectContaining({
          name: 'direct-typescript-operation',
          source: 'typescript',
        }),
      );
    }, 60_000);
  }
});

describe('configured reload through Specmatic', () => {
  let app: E2eApp | undefined;
  let fixtureRoot: string;

  beforeAll(async () => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'potemkin-configured-watch-e2e-'));
    fs.cpSync(FIXTURE, fixtureRoot, { recursive: true });
    const configPath = path.join(fixtureRoot, 'potemkin-mixed.yml');
    fs.writeFileSync(
      configPath,
      fs
        .readFileSync(configPath, 'utf8')
        .replace('typescript:\n', 'typescript:\n  watchIntervalMs: 100\n'),
    );
    app = await startE2eApp({
      potemkinConfigPath: configPath,
      warmupPath: '/things/not-created',
      warmupExpectedStatus: 404,
    });
    expect(app.stubForwardingHealthy).toBe(true);
  }, 180_000);

  afterAll(async () => {
    await app?.shutdown();
    if (app !== undefined) {
      await startE2eApp({
        potemkinConfigPath: path.join(FIXTURE, 'potemkin-yaml.yml'),
        warmupPath: '/things/not-created',
        warmupExpectedStatus: 404,
      });
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }, 30_000);

  it('reloads changed YAML through Specmatic and clears the previous runtime', async () => {
    const firstResponse = await postThing(app!.stubUrl, 'before-reload');
    expect(firstResponse.source).toBe('yaml');

    const yamlPath = path.join(fixtureRoot, 'yaml/mixed/thing.yaml');
    fs.writeFileSync(
      yamlPath,
      fs
        .readFileSync(yamlPath, 'utf8')
        .replace('source: "sourceLabel(\'yaml\')"', 'source: "sourceLabel(\'yaml-reloaded\')"'),
    );

    await forceReload(app!.engineUrl);
    const reloaded = await postThing(app!.stubUrl, 'after-reload');
    expect(reloaded.source).toBe('yaml-reloaded');

    const oldState = await fetch(`${app!.stubUrl}/things/${firstResponse.id}`, {
      headers: { Accept: 'application/json' },
    });
    expect(oldState.status).toBe(404);
  }, 60_000);

  it('reloads when the single potemkin configuration file changes', async () => {
    const currentConfigPath = app!.configurationPath;
    const responseBeforeConfigReload = await postThing(app!.stubUrl, 'config-reload-before');
    const config = fs.readFileSync(currentConfigPath, 'utf8');
    fs.writeFileSync(
      currentConfigPath,
      config.replace('watchIntervalMs: 100', 'watchIntervalMs: 125'),
    );

    await forceReload(app!.engineUrl);
    const cleared = await fetch(`${app!.stubUrl}/things/${responseBeforeConfigReload.id}`, {
      headers: { Accept: 'application/json' },
    });
    expect(cleared.status).toBe(404);
  }, 60_000);

  it('automatically reloads a changed watched source through Specmatic', async () => {
    const yamlPath = path.join(fixtureRoot, 'yaml/mixed/thing.yaml');
    const baseline = fs
      .readFileSync(yamlPath, 'utf8')
      .replace(/sourceLabel\('yaml(?:-reloaded|-automatic-reload)?'\)/g, "sourceLabel('yaml')");
    fs.writeFileSync(yamlPath, baseline);
    await forceReload(app!.engineUrl);
    const before = await postThing(app!.stubUrl, 'automatic-reload-before');
    expect(before.source).toBe('yaml');

    fs.writeFileSync(
      yamlPath,
      fs
        .readFileSync(yamlPath, 'utf8')
        .replace("sourceLabel('yaml-reloaded')", "sourceLabel('yaml-automatic-reload')")
        .replace("sourceLabel('yaml')", "sourceLabel('yaml-automatic-reload')"),
    );

    const deadline = Date.now() + 10_000;
    let observed: { id: string; source: string } | undefined;
    while (Date.now() < deadline) {
      const candidate = await postThing(app!.stubUrl, 'automatic-reload-after');
      if (candidate.source === 'yaml-automatic-reload') {
        observed = candidate;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(observed).toEqual(
      expect.objectContaining({ id: expect.any(String), source: 'yaml-automatic-reload' }),
    );
    const oldState = await fetch(`${app!.stubUrl}/things/${before.id}`, {
      headers: { Accept: 'application/json' },
    });
    expect(oldState.status).toBe(404);
  }, 60_000);
});

async function postThing(stubUrl: string, name: string): Promise<{ id: string; source: string }> {
  const response = await fetch(`${stubUrl}/things`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; source: string };
}

async function forceReload(engineUrl: string): Promise<void> {
  const response = await fetch(`${engineUrl}/_admin/force-reload`, { method: 'POST' });
  expect(response.status).toBe(200);
}
