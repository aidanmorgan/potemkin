import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { validatePotemkinConfig } from '../../src/dsl/configSchema.js';
import type { PotemkinConfiguration } from '../../src/contracts/config.js';
import { compileSeeds, type SeedCompileContext } from '../../src/dsl/seedCompiler.js';

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'seeds-engine');

describe('seeds: YAML compilation', () => {
  let config: PotemkinConfiguration;

  beforeAll(() => {
    const raw = yaml.load(fs.readFileSync(path.join(FIXTURE_DIR, 'potemkin.yml'), 'utf8'));
    config = validatePotemkinConfig(raw, { source: 'seeds-engine/potemkin.yml' });
  });

  it('parses both configured seeds', () => {
    expect(config.seeds).toHaveLength(2);
    expect(config.seeds?.[0]).toMatchObject({
      description: 'seed-widget-from-empty',
      base: 'empty',
      request: { method: 'GET', path: '/widgets/seeded-1' },
    });
    expect(config.seeds?.[1]).toMatchObject({
      description: 'seed-widget-from-contract',
      base: 'contract',
      request: { method: 'GET', path: '/gadgets/seeded-2' },
    });
  });

  it('compiles an empty-base seed', () => {
    const ctx: SeedCompileContext = { resolveContractBase: () => ({}) };
    const compiled = compileSeeds(config.seeds! as Parameters<typeof compileSeeds>[0], ctx);
    const seed = compiled.find((candidate) => candidate.request.path === '/widgets/seeded-1');
    expect(seed).toBeDefined();
    expect(seed!.body).toMatchObject({ id: 'seeded-1', kind: 'ALPHA', label: 'from-empty-seed' });
    expect(seed!.journal.every((entry) => entry.source === 'seed')).toBe(true);
  });

  it('compiles a contract-base seed', () => {
    const ctx: SeedCompileContext = {
      resolveContractBase: () => ({ id: 'contract-gen', kind: 'DEFAULT' }),
    };
    const compiled = compileSeeds(config.seeds! as Parameters<typeof compileSeeds>[0], ctx);
    const seed = compiled.find((candidate) => candidate.request.path === '/gadgets/seeded-2');
    expect(seed).toBeDefined();
    expect(seed!.body).toMatchObject({ id: 'seeded-2', kind: 'BETA', label: 'from-contract-seed' });
    expect(seed!.journal.every((entry) => entry.source === 'seed')).toBe(true);
  });
});
