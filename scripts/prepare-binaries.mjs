import { chmod, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.cwd());
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

for (const [name, relativeTarget] of Object.entries(packageJson.bin ?? {})) {
  const target = path.resolve(root, relativeTarget);
  await chmod(target, 0o755);
  console.log(`Prepared ${name}: ${path.relative(root, target)}`);
}
