import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const failures = [];
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));

const packageJson = JSON.parse(read('package.json'));
const exports = packageJson.exports ?? {};
const allowedExports = new Set([
  '.',
  './parser',
  './project',
  './model',
  './runtime',
  './http',
  './contract',
  './sdk',
  './generation',
  './language-server',
  './typescript-plugin',
  './package.json',
]);
for (const name of Object.keys(exports)) {
  if (!allowedExports.has(name)) failures.push(`package export ${name} is not an approved facade`);
  if (name === './package.json') continue;
  const entry = exports[name];
  const target = typeof entry === 'string' ? entry : (entry?.default ?? entry?.require);
  if (typeof target !== 'string') {
    failures.push(`package export ${name} has no runtime target`);
    continue;
  }
  const source = target.replace(/^\.\/dist\/src\//, 'src/').replace(/\.js$/, '.ts');
  if (!exists(source)) failures.push(`package export ${name} points at missing source ${source}`);
}

const rootSource = read('src/index.ts');
for (const symbol of [
  'RuntimeModel',
  'RuntimeProgram',
  'RuntimeEngine',
  'RuntimeSystem',
  'RuntimeDefinition',
  'compileRuntime',
]) {
  if (new RegExp(`\\b${symbol}\\b`).test(rootSource)) {
    failures.push(`package root mentions private runtime symbol ${symbol}`);
  }
}

const forbiddenDomainImports =
  /from ["'][^"']*(?:dsl|cel|parser|http|conformance|language-server)[^"']*["']/;
for (const file of ['src/model/compiler.ts', 'src/model/runtime.ts', 'src/core/engine.ts']) {
  if (forbiddenDomainImports.test(read(file)))
    failures.push(`${file} imports an adapter/parser context`);
}

const foundationForbiddenImports =
  /from ["'][^"']*(?:authoring|cel|cli|conformance|dsl|http|language-server|parser|runtime|model|core|openapi|project|sdk|typescript-plugin)[^"']*["']/;
for (const file of fs.readdirSync(path.join(root, 'src', 'contracts'), { withFileTypes: true })) {
  if (!file.isFile() || !file.name.endsWith('.ts')) continue;
  const relative = `src/contracts/${file.name}`;
  if (foundationForbiddenImports.test(read(relative))) {
    failures.push(`${relative} imports an adapter or runtime implementation`);
  }
}
if (
  /from ["'][^"']*(?:http|authoring\/lifecycle|lifecycle\/types|dsl\/configSchema)[^"']*["']/.test(
    read('src/dsl/types.ts'),
  )
) {
  failures.push(
    'src/dsl/types.ts imports an adapter implementation instead of foundation contracts',
  );
}
for (const file of ['src/http/responseMutations.ts', 'src/http/securityHeaders.ts']) {
  if (/from ["'][^"']*dsl[^"']*["']/.test(read(file))) {
    failures.push(
      `${file} imports a DSL implementation; HTTP must consume source-neutral contracts`,
    );
  }
}

for (const file of [
  'docs/design/main-readme-feature-completeness.md',
  'docs/design/main-readme-feature-audit-review.md',
]) {
  if (!exists(file)) failures.push(`required architecture evidence ${file} is missing`);
}
for (const file of ['docs/design/context-map.md', 'docs/design/dependency-matrix.md']) {
  if (!exists(file)) failures.push(`required bounded-context evidence ${file} is missing`);
}

const sourceRoot = path.join(root, 'src');
const ownedTopLevel = new Set([
  'authoring',
  'cel',
  'cli',
  'config.ts',
  'contracts',
  'conformance',
  'domain',
  'contract',
  'core',
  'dsl',
  'errors.ts',
  'generation',
  'http',
  'http.ts',
  'index.ts',
  'identity',
  'idempotency',
  'ids',
  'language-server',
  'lifecycle',
  'lint',
  'model',
  'observability',
  'openapi',
  'parser',
  'project',
  'runtime',
  'schema',
  'sdk',
  'typescript-plugin',
  'types.ts',
  'webhooks',
]);
for (const entry of fs.readdirSync(sourceRoot)) {
  const absolute = path.join(sourceRoot, entry);
  const isProductionModule =
    entry.endsWith('.ts') ||
    (fs.statSync(absolute).isDirectory() && fs.readdirSync(absolute).length > 0);
  if (isProductionModule && !ownedTopLevel.has(entry)) {
    failures.push(`unowned production source path src/${entry}; update context-map.md first`);
  }
}

const distRoot = path.join(root, 'dist/src');
if (fs.existsSync(distRoot)) {
  const rootDeclaration = path.join(distRoot, 'index.d.ts');
  if (
    fs.existsSync(rootDeclaration) &&
    fs.statSync(rootDeclaration).mtimeMs >= fs.statSync(path.join(root, 'src/index.ts')).mtimeMs
  ) {
    const generatedRoot = fs.readFileSync(rootDeclaration, 'utf8');
    if (/\bRuntime(?:Model|Program|Engine|System|Definition)\b/.test(generatedRoot)) {
      failures.push('generated package root declaration leaks private runtime symbols');
    }
  }
  const sdkDeclaration = path.join(distRoot, 'sdk/index.d.ts');
  const sdkSource = path.join(root, 'src/sdk/index.ts');
  if (
    fs.existsSync(sdkDeclaration) &&
    fs.statSync(sdkDeclaration).mtimeMs >= fs.statSync(sdkSource).mtimeMs
  ) {
    const generatedSdk = fs.readFileSync(sdkDeclaration, 'utf8');
    if (
      /\bRuntime(?:Model|Program|Engine|System|Definition|Dependencies)\b|model\/runtime|model\/compiler|(?:^|["'])\.\.\/parser\//.test(
        generatedSdk,
      )
    ) {
      failures.push(
        'generated SDK declaration leaks runtime/compiler/parser implementation symbols',
      );
    }
  }
}

if (failures.length > 0) {
  console.error('Architecture verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    'Architecture verification passed: package facades, domain imports, and evidence paths are valid.',
  );
}
