import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

function filesUnder(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const file = path.join(root, entry);
    if (statSync(file).isDirectory()) files.push(...filesUnder(file));
    else files.push(file);
  }
  return files;
}

describe('source tree architecture', () => {
  it('keeps the documented production layers present and independently named', () => {
    const root = process.cwd();
    const requiredDirectories = [
      'src/authoring',
      'src/dsl',
      'src/parser',
      'src/model',
      'src/core',
      'src/runtime',
      'src/http',
      'src/contract',
      'src/cli',
      'src/conformance',
      'plugin/src/main/kotlin',
    ];
    expect(requiredDirectories.every((directory) => existsSync(path.join(root, directory)))).toBe(
      true,
    );
    expect(existsSync(path.join(root, 'src/core/runtime.ts'))).toBe(false);
    expect(existsSync(path.join(root, 'src/core/compiler.ts'))).toBe(false);
    expect(existsSync(path.join(root, 'src/core/patches.ts'))).toBe(false);
    expect(existsSync(path.join(root, 'src/core/builders.ts'))).toBe(false);
    expect(existsSync(path.join(root, 'src/core/data.ts'))).toBe(false);
  });

  it('keeps conformance composition infrastructure in the production layer', () => {
    const root = process.cwd();
    const requiredModules = [
      'src/conformance/binaries.ts',
      'src/conformance/exampleStack.ts',
      'src/conformance/exportedCorpus.ts',
      'src/conformance/portAllocator.ts',
      'src/conformance/specmaticProcess.ts',
    ];
    expect(requiredModules.every((file) => existsSync(path.join(root, file)))).toBe(true);
  });

  it('keeps TypeScript discovery and loading in the parser loader layer', () => {
    const root = process.cwd();
    const parserFiles = [
      'typescriptLoader.ts',
      'typescriptFactoryScanner.ts',
      'typescriptDiscovery.ts',
      'typescriptFactorySyntax.ts',
      'typescriptModuleLoader.ts',
    ];
    expect(parserFiles.every((file) => existsSync(path.join(root, 'src/parser', file)))).toBe(true);
    expect(
      filesUnder(path.join(root, 'src/authoring')).filter((file) =>
        /(typescriptDiscovery|factoryScanner|factorySyntax)/.test(path.basename(file)),
      ),
    ).toEqual([]);
  });

  it('gives the YAML parser an explicit module name instead of a generic index', () => {
    const root = process.cwd();
    expect(existsSync(path.join(root, 'src/parser/yamlParser.ts'))).toBe(true);
    expect(existsSync(path.join(root, 'src/parser/index.ts'))).toBe(false);
  });

  it('uses only the canonical potemkin.yml configuration filename', () => {
    const root = process.cwd();
    const legacyConfigName = ['potemkin', 'yaml'].join('.');
    const files = [
      'src',
      'plugin',
      'tests',
      'examples',
      'docs',
      'README.md',
      'requirements.md',
      'docker-compose.yml',
      'scripts',
    ].flatMap((entry) => {
      const file = path.join(root, entry);
      return statSync(file).isDirectory() ? filesUnder(file) : [file];
    });
    expect(files.filter((file) => path.basename(file) === legacyConfigName)).toEqual([]);
    const text = files
      .filter((file) => /\.(md|ts|kt|kts|yml|yaml|json|mjs|cjs)$/.test(file))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(text).not.toContain(legacyConfigName);
  });

  it('keeps tests in descriptive layer directories without numeric E2E names', () => {
    const testRoot = path.join(process.cwd(), 'tests');
    const allowedRoots = new Set([
      'unit',
      'runtime',
      'integration',
      'property',
      'redteam',
      'bdd',
      'e2e',
      'examples',
    ]);
    const files = filesUnder(testRoot).filter((file) => /\.(test|spec)\.ts$|\.feature$/.test(file));
    const misplaced = files.filter(
      (file) => !allowedRoots.has(path.relative(testRoot, file).split(path.sep)[0]!),
    );
    const numericE2e = files
      .filter((file) => path.relative(testRoot, file).split(path.sep)[0] === 'e2e')
      .filter((file) => /^\d{2,}-/.test(path.basename(file)));
    expect(misplaced).toEqual([]);
    expect(numericE2e).toEqual([]);
  });

  it('contains no stale references to removed numbered E2E files or old runtime smoke paths', () => {
    const roots = ['README.md', 'requirements.md', 'docs', 'tests'];
    const files = roots.flatMap((entry) => {
      const file = path.join(process.cwd(), entry);
      return statSync(file).isDirectory() ? filesUnder(file) : [file];
    });
    const text = files
      .filter((file) => /\.(md|ts|feature|cjs|json|yaml)$/.test(file))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(text).not.toMatch(/tests\/e2e\/\d{2,}-[^\s`)]*\.e2e-test\.ts/);
    expect(text).not.toContain(['runtime-authoring-parity', 'e2e-test.ts'].join('.'));
    expect(text).not.toContain(['tests/runtime', 'authoring-parity.runtime.test.ts'].join('/'));
  });

  it('keeps documented production source paths resolvable', () => {
    const root = process.cwd();
    const files = ['README.md', 'requirements.md', 'docs', 'tests', 'examples', 'plugin'].flatMap(
      (entry) => {
        const file = path.join(root, entry);
        return statSync(file).isDirectory() ? filesUnder(file) : [file];
      },
    );
    const unresolved = files
      .filter((file) => file !== path.join(root, 'tests/unit/audit/sourceTree.test.ts'))
      .filter((file) => !file.startsWith(path.join(root, 'plugin/bin') + path.sep))
      .filter((file) => /\.(md|ts|feature|cjs|kt|kts|json|yaml|yml)$/.test(file))
      .flatMap((file) => {
        const source = readFileSync(file, 'utf8');
        // Do not treat generated `gen-src/` paths as production `src/` paths.
        return [...source.matchAll(/(?<![A-Za-z0-9_-])src\/[A-Za-z0-9_./-]+\.ts\b/g)].map(
          (match) => ({
            file,
            reference: match[0],
          }),
        );
      })
      .filter(({ reference }) => !existsSync(path.join(root, reference)))
      .map(({ file, reference }) => `${path.relative(root, file)} -> ${reference}`);

    expect(unresolved).toEqual([]);
  });

  it('keeps HTTP transport concerns in their owning modules', () => {
    const root = process.cwd();
    const gateway = readFileSync(path.join(root, 'src/http/runtimeGateway.ts'), 'utf8');
    const admin = readFileSync(path.join(root, 'src/http/runtimeAdminRoutes.ts'), 'utf8');
    const observation = readFileSync(path.join(root, 'src/http/runtimeObservation.ts'), 'utf8');

    expect(gateway).not.toContain("app.post('/_admin/force-reload'");
    expect(gateway).not.toContain('observeTransportRequestResponse');
    expect(admin).toContain("app.post('/_admin/force-reload'");
    expect(observation).toContain('export function installRuntimeObservation');
  });
});
