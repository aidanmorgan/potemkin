import { execFileSync } from 'node:child_process';
import path from 'node:path';

describe('architecture verification gate', () => {
  it('passes against the current source and package facade graph', () => {
    expect(
      execFileSync(process.execPath, [path.join(process.cwd(), 'scripts/check-architecture.mjs')], {
        encoding: 'utf8',
      }),
    ).toContain('Architecture verification passed');
  });
});
