import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];
const exists = (relative) => fs.existsSync(path.join(root, relative));
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

for (const removed of [
  'src/authoring/runtimeModel.ts',
  'src/authoring/references.ts',
  'src/core/queryPolicies.ts',
]) {
  if (exists(removed)) failures.push(`removed implementation path exists: ${removed}`);
}

const sdkDeclaration = 'dist/src/sdk/index.d.ts';
if (exists(sdkDeclaration)) {
  const declaration = read(sdkDeclaration);
  for (const legacy of ['when?', 'event?', 'seed?', 'policies?', 'helpers?']) {
    if (declaration.includes(legacy))
      failures.push(`legacy SDK member appears in generated declaration: ${legacy}`);
  }
  if (
    /Runtime(?:Model|Program|System|Engine|Definition)|model\/runtime|model\/compiler|parser\//.test(
      declaration,
    )
  ) {
    failures.push('generated SDK declaration contains runtime/compiler/parser symbols');
  }
}

const packageJson = JSON.parse(read('package.json'));
if (Object.keys(packageJson.exports ?? {}).some((name) => /legacy|compat|internal/i.test(name))) {
  failures.push('package exports contain a legacy/compatibility/internal path');
}

if (failures.length > 0) {
  console.error('Cleanup verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    'Cleanup verification passed: removed paths and generated SDK declarations are clean.',
  );
}
