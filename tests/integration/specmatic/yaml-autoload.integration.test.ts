/**
 * yaml-autoload.integration.test.ts
 *
 * Tests for T2 specmaticConfig stub-dir auto-load on boot:
 *  - Boot with specmaticConfig.configPath reads stubs[] dirs from the YAML
 *  - Boot with specmaticConfig.stubDirs loads explicit directories
 *  - Stubs from both sources are pre-populated in the expectation store
 *  - Non-existent directories are handled gracefully (non-fatal)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { bootSystem } from '../../../src/engine/boot.js';
import { createGateway } from '../../../src/http/gateway.js';
import { loadBankingFixture } from '../_helpers/inline-fixture.js';

// The existing fixture stubs live here (3 stubs)
const FIXTURE_STUB_DIR = path.resolve(__dirname, '../../fixtures/specmatic-stubs');

describe('yaml-autoload.integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-t2-autoload-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeStubFile(dir: string, name: string, method: string, stubPath: string, body: unknown) {
    const stub = {
      'http-request': { method, path: stubPath },
      'http-response': { status: 200, body },
    };
    fs.writeFileSync(path.join(dir, name), JSON.stringify(stub, null, 2));
  }

  function writeSpecmaticYaml(configDir: string, stubDirNames: string[]): string {
    const configPath = path.join(configDir, 'specmatic.yaml');
    const yaml = [
      'stubs:',
      ...stubDirNames.map((d) => `  - ${d}`),
    ].join('\n');
    fs.writeFileSync(configPath, yaml);
    return configPath;
  }

  it('boot with specmaticConfig.stubDirs pre-loads stubs from the directory', async () => {
    writeStubFile(tmpDir, 'stub-a.json', 'GET', '/customers/autoload-a',
      { id: 'autoload-a', name: 'AutoA', riskBand: 'LOW' });

    const fixture = await loadBankingFixture();
    const sys = await bootSystem({ ...fixture, specmaticConfig: { stubDirs: [tmpDir] } });

    const fileStubs = sys.expectations.list().filter((e) => e.source === 'file');
    expect(fileStubs.length).toBeGreaterThanOrEqual(1);
    const autoA = fileStubs.find((e) => e.request.path === '/customers/autoload-a');
    expect(autoA).toBeDefined();
  });

  it('stub from specmaticConfig.stubDirs responds correctly via HTTP', async () => {
    writeStubFile(tmpDir, 'stub-http.json', 'GET', '/customers/autoload-http',
      { id: 'autoload-http', name: 'AutoHTTP', riskBand: 'HIGH' });

    const fixture = await loadBankingFixture();
    const sys = await bootSystem({ ...fixture, specmaticConfig: { stubDirs: [tmpDir] } });
    const app = createGateway(sys);
    const agent = request(app);

    const res = await agent.get('/customers/autoload-http').expect(200);
    expect(res.body.name).toBe('AutoHTTP');
  });

  it('boot with specmaticConfig.configPath reads stubs[] paths from YAML', async () => {
    // Create a stub subdir relative to the config dir
    const stubSubDir = path.join(tmpDir, 'my-stubs');
    fs.mkdirSync(stubSubDir);
    writeStubFile(stubSubDir, 'yaml-stub.json', 'GET', '/customers/from-yaml',
      { id: 'from-yaml', name: 'FromYaml', riskBand: 'LOW' });

    // Write a specmatic.yaml referencing the relative stub dir name
    const configPath = writeSpecmaticYaml(tmpDir, ['my-stubs']);

    const fixture = await loadBankingFixture();
    const sys = await bootSystem({ ...fixture, specmaticConfig: { configPath } });

    const fileStubs = sys.expectations.list().filter((e) => e.source === 'file');
    const yamlStub = fileStubs.find((e) => e.request.path === '/customers/from-yaml');
    expect(yamlStub).toBeDefined();
  });

  it('stub from configPath-derived dir responds correctly via HTTP', async () => {
    const stubSubDir = path.join(tmpDir, 'config-stubs');
    fs.mkdirSync(stubSubDir);
    writeStubFile(stubSubDir, 'cfg-stub.json', 'GET', '/customers/cfg-loaded',
      { id: 'cfg-loaded', name: 'CfgLoaded', riskBand: 'LOW' });

    const configPath = writeSpecmaticYaml(tmpDir, ['config-stubs']);

    const fixture = await loadBankingFixture();
    const sys = await bootSystem({ ...fixture, specmaticConfig: { configPath } });
    const app = createGateway(sys);
    const agent = request(app);

    const res = await agent.get('/customers/cfg-loaded').expect(200);
    expect(res.body.id).toBe('cfg-loaded');
  });

  it('both configPath and stubDirs can be provided; stubs from both are loaded', async () => {
    // stubDirs entry
    const dirA = path.join(tmpDir, 'dir-a');
    fs.mkdirSync(dirA);
    writeStubFile(dirA, 'a.json', 'GET', '/customers/both-a',
      { id: 'both-a', name: 'BothA', riskBand: 'LOW' });

    // configPath-derived entry
    const dirB = path.join(tmpDir, 'dir-b');
    fs.mkdirSync(dirB);
    writeStubFile(dirB, 'b.json', 'GET', '/customers/both-b',
      { id: 'both-b', name: 'BothB', riskBand: 'LOW' });
    const configPath = writeSpecmaticYaml(tmpDir, ['dir-b']);

    const fixture = await loadBankingFixture();
    const sys = await bootSystem({ ...fixture, specmaticConfig: { configPath, stubDirs: [dirA] } });

    const paths = sys.expectations.list().map((e) => e.request.path);
    expect(paths).toContain('/customers/both-a');
    expect(paths).toContain('/customers/both-b');
  });

  it('non-existent stub dir in specmaticConfig is handled gracefully (boot still succeeds)', async () => {
    const fixture = await loadBankingFixture();
    // Should not throw
    const sys = await bootSystem({
      ...fixture,
      specmaticConfig: { stubDirs: ['/no/such/dir/at/all'] },
    });
    expect(sys.expectations.size()).toBe(0);
  });

  it('specmaticStubDir and specmaticConfig can be used together', async () => {
    writeStubFile(tmpDir, 'cfg-only.json', 'GET', '/customers/cfg-only',
      { id: 'cfg-only', name: 'CfgOnly', riskBand: 'LOW' });

    const fixture = await loadBankingFixture();
    // specmaticStubDir loads from fixture (3 stubs); specmaticConfig loads from tmpDir
    const sys = await bootSystem({
      ...fixture,
      specmaticStubDir: FIXTURE_STUB_DIR,
      specmaticConfig: { stubDirs: [tmpDir] },
    });

    const fileStubs = sys.expectations.list().filter((e) => e.source === 'file');
    // 3 from fixture + 1 from tmp
    expect(fileStubs.length).toBe(4);
  });
});
