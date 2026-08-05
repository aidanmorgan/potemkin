import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const root = process.cwd();
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const inventory = readJson('docs/design/public-api-inventory.json');
const packageJson = readJson('package.json');
const failures = [];

const packageExports = packageJson.exports ?? {};
const expectedExports = inventory.packageExports ?? {};
if (
  JSON.stringify(Object.keys(packageExports).sort()) !==
  JSON.stringify(Object.keys(expectedExports).sort())
) {
  failures.push('package export names differ from docs/design/public-api-inventory.json');
}
for (const [name, source] of Object.entries(expectedExports)) {
  if (name === './package.json') continue;
  const entry = packageExports[name];
  const target =
    typeof entry === 'string' ? entry : (entry?.types ?? entry?.default ?? entry?.require);
  const actual =
    typeof target === 'string'
      ? target
          .replace(/^\.\/dist\/src\//, 'src/')
          .replace(/\.d\.ts$/, '.ts')
          .replace(/\.js$/, '.ts')
      : undefined;
  if (actual !== source)
    failures.push(`${name} points to ${actual ?? 'no source'}, expected ${source}`);
  if (source !== null && !fs.existsSync(path.join(root, source)))
    failures.push(`${name} source ${source} is missing`);
  const typesTarget = typeof entry === 'object' && entry !== null ? entry.types : undefined;
  if (
    process.env.POTEMKIN_VERIFY_DIST === '1' &&
    typeof typesTarget === 'string' &&
    !fs.existsSync(path.join(root, typesTarget))
  ) {
    failures.push(
      `${name} compiled declaration ${typesTarget} is missing; run the build before publishing`,
    );
  }
}

const expectedBins = Object.fromEntries(
  Object.entries(inventory.packageBins ?? {}).map(([name, source]) => [
    name,
    `./dist/${source.replace(/^src\//, 'src/').replace(/\.ts$/, '.js')}`,
  ]),
);
if (JSON.stringify(packageJson.bin ?? {}) !== JSON.stringify(expectedBins))
  failures.push('package bins differ from the checked-in inventory');
for (const entry of inventory.compositionRoots ?? []) {
  if (!fs.existsSync(path.join(root, entry.path)))
    failures.push(`composition root is missing: ${entry.path}`);
}
for (const entry of inventory.adapterBoundaries ?? []) {
  if (!fs.existsSync(path.join(root, entry.path)))
    failures.push(`adapter boundary is missing: ${entry.path}`);
}

const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile).config;
const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
for (const [source, expected] of Object.entries(inventory.symbols ?? {})) {
  const file = program.getSourceFile(path.join(root, source));
  const symbol = file === undefined ? undefined : checker.getSymbolAtLocation(file);
  const actual =
    symbol === undefined
      ? []
      : checker
          .getExportsOfModule(symbol)
          .map((item) => item.getName())
          .sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    failures.push(`${source} exported symbols differ from inventory`);
  }
}

if (failures.length > 0) {
  console.error('Public API inventory verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Public API inventory verification passed.');
}
