import { compileSeed, compileSeeds, type SeedCompileContext } from '../../../src/dsl/seedCompiler.js';

describe('compileSeed — base: empty', () => {
  const ctx: SeedCompileContext = { resolveContractBase: () => ({}) };

  it('produces a body from {} + patches', () => {
    const s = compileSeed(
      {
        request: { method: 'GET', path: '/leads/seed-1' },
        base: 'empty',
        patches: [
          { op: 'add', path: '/id', value: 'seed-1' },
          { op: 'add', path: '/status', value: 'OPEN' },
        ],
      },
      ctx,
    );
    expect(s.body).toEqual({ id: 'seed-1', status: 'OPEN' });
  });

  it('journal entries are tagged source: seed', () => {
    const s = compileSeed(
      {
        request: { method: 'GET', path: '/x' },
        base: 'empty',
        patches: [{ op: 'add', path: '/x', value: 1 }],
      },
      ctx,
    );
    expect(s.journal.every((j) => j.source === 'seed')).toBe(true);
  });
});

describe('compileSeed — base: contract', () => {
  it('uses the supplied contract-resolved base body', () => {
    const ctx: SeedCompileContext = {
      resolveContractBase: () => ({ id: 'gen', status: 'NEW' }),
    };
    const s = compileSeed(
      {
        request: { method: 'GET', path: '/leads/seed-2' },
        base: 'contract',
        patches: [{ op: 'replace', path: '/id', value: 'seed-2' }],
      },
      ctx,
    );
    expect(s.body).toEqual({ id: 'seed-2', status: 'NEW' });
  });
});

describe('compileSeeds — many entries', () => {
  it('returns a CompiledSeed per declared seed in order', () => {
    const ctx: SeedCompileContext = { resolveContractBase: () => ({}) };
    const out = compileSeeds(
      [
        { request: { method: 'GET', path: '/a' }, base: 'empty', patches: [{ op: 'add', path: '/a', value: 1 }] },
        { request: { method: 'GET', path: '/b' }, base: 'empty', patches: [{ op: 'add', path: '/b', value: 2 }] },
      ],
      ctx,
    );
    expect(out.map((s) => s.request.path)).toEqual(['/a', '/b']);
    expect(out[0].body).toEqual({ a: 1 });
    expect(out[1].body).toEqual({ b: 2 });
  });
});
