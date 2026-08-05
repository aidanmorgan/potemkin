import { mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(process.cwd());
const editorRoot = path.join(root, 'editors', 'vscode');
const artifacts = path.join(root, '.artifacts');
const editorPackage = JSON.parse(await readFile(path.join(editorRoot, 'package.json'), 'utf8'));
const output = path.join(artifacts, `${editorPackage.name}-${editorPackage.version}.vsix`);

await mkdir(artifacts, { recursive: true });
execFileSync('npm', ['install', '--prefix', editorRoot, '--no-package-lock', '--ignore-scripts'], {
  cwd: root,
  stdio: 'inherit',
});
execFileSync('pnpm', ['dlx', '@vscode/vsce', 'package', '--out', output], {
  cwd: editorRoot,
  stdio: 'inherit',
});
