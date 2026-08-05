import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(process.cwd());
const artifacts = path.join(root, '.artifacts');
await mkdir(artifacts, { recursive: true });

execFileSync('npm', ['pack', '--pack-destination', artifacts], {
  cwd: root,
  stdio: 'inherit',
});
