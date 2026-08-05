import { execFileSync } from 'node:child_process';

describe('public API inventory', () => {
  it('matches package facades, bins, and checker-visible symbols', () => {
    expect(execFileSync('node', ['scripts/check-public-api.mjs'], { encoding: 'utf8' })).toContain(
      'Public API inventory verification passed.',
    );
  });
});
