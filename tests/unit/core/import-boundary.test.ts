import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import ts from 'typescript';

function localImports(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const modules: string[] = [];
  for (const statement of source.statements) {
    const moduleSpecifier =
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        ? statement.moduleSpecifier
        : undefined;
    if (
      moduleSpecifier === undefined ||
      !ts.isStringLiteral(moduleSpecifier) ||
      !moduleSpecifier.text.startsWith('.')
    )
      continue;
    modules.push(moduleSpecifier.text);
  }
  return modules;
}

function resolveLocalImport(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier.replace(/\.js$/, ''));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // External and generated imports are outside this static boundary check.
    }
  }
  return undefined;
}

function reachableLocalModules(root: string): string[] {
  const queue = [resolve(root)];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const specifier of localImports(current)) {
      const imported = resolveLocalImport(current, specifier);
      if (imported !== undefined && !visited.has(imported)) queue.push(imported);
    }
  }
  return [...visited];
}

describe('core import boundary', () => {
  it('publishes parser and runtime entry points without source-specific bridges', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
      files?: readonly string[];
      [key: string]: unknown;
    };
    expect(packageJson.files).toContain('dist');
    expect(Object.keys(packageJson).filter((key) => key.startsWith('./'))).toEqual([]);
    const parser = packageJson.exports['./parser'] as { types?: string };
    const runtime = packageJson.exports['./runtime'] as { types?: string };
    const model = packageJson.exports['./model'] as { types?: string };
    expect(parser.types).toContain('parser/public.d.ts');
    expect(runtime.types).toContain('runtime/system.d.ts');
    expect(model.types).toContain('model/index.d.ts');
    expect(packageJson.exports['./runtime/files']).toBeUndefined();
    expect(packageJson.exports['./runtime/mixed']).toBeUndefined();
    expect(runtime.types).not.toContain('parser');
    expect(packageJson.exports['./core']).toBeUndefined();
    expect(packageJson.exports['./core/compiler']).toBeUndefined();
    expect(packageJson.exports['./core/patches']).toBeUndefined();
    expect(packageJson.exports['./core/builders']).toBeUndefined();
    expect(packageJson.exports['./generation']).toBeDefined();
    expect(packageJson.exports['./model/builders']).toBeUndefined();
    expect(packageJson.exports['./model/compiler']).toBeUndefined();
    expect(packageJson.exports['./model/patches']).toBeUndefined();
  });

  it('keeps parser implementation helpers out of the public parser entry point', async () => {
    const parser = await import('../../../src/parser/public.js');
    expect(parser).toHaveProperty('compileYamlProgram');
    expect(parser).not.toHaveProperty('compileYamlModel');
    expect(parser).not.toHaveProperty('compileYamlFaultRule');
    expect(parser).not.toHaveProperty('parseRuntimeFaultRegistration');
  });

  it('keeps TypeScript authoring on the explicit SDK surface', async () => {
    const root = await import('../../../src/index.js');
    const sdk = await import('../../../src/sdk/index.js');
    expect(root).not.toHaveProperty('boundary');
    expect(root).not.toHaveProperty('PotemkinConfigure');
    expect(root).not.toHaveProperty('defineSimulation');
    expect(sdk).toHaveProperty('sdk');
    expect(sdk.sdk).toHaveProperty('boundary');
    expect(sdk.sdk).toHaveProperty('PotemkinConfigure');
  });

  it('keeps the injected SDK facade aligned with the curated authoring surface', async () => {
    const authoring = await import('../../../src/authoring/public.js');
    const sdk = await import('../../../src/sdk/index.js');
    const typedOverrides = new Set(['eventType', 'operationId', 'schemaReference']);

    for (const [name, value] of Object.entries(authoring)) {
      if (name === 'default' || name === 'module.exports' || typedOverrides.has(name)) continue;
      expect(sdk).toHaveProperty(name, value);
      expect(sdk.sdk).toHaveProperty(name, value);
    }

    expect(sdk.eventType).not.toBe(authoring.eventType);
    expect(sdk.operationId).not.toBe(authoring.operationId);
    expect(sdk.schemaReference).not.toBe(authoring.schemaReference);
  });

  it('keeps the SDK closure independent of runtime and transport implementation packages', () => {
    const sourceRoot = resolve(process.cwd(), 'src');
    const forbidden = [
      join(sourceRoot, 'model') + sep,
      join(sourceRoot, 'core') + sep,
      join(sourceRoot, 'runtime') + sep,
      join(sourceRoot, 'http') + sep,
      join(sourceRoot, 'contract') + sep,
      join(sourceRoot, 'parser') + sep,
      join(sourceRoot, 'dsl') + sep,
      join(sourceRoot, 'cel') + sep,
    ];
    const violations = reachableLocalModules(join(sourceRoot, 'sdk', 'index.ts'))
      .filter((file) => forbidden.some((fragment) => file.includes(fragment)))
      .map((file) => relative(process.cwd(), file));
    expect(violations).toEqual([]);
  });

  it('keeps YAML, DSL, CEL, and parser implementation out of the runtime engine', () => {
    const root = join(process.cwd(), 'src', 'core');
    for (const file of readdirSync(root).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(root, file), 'utf8');
      expect(source).not.toMatch(/from ['"].*\/(?:dsl|cel|parser)\//);
      expect(source).not.toMatch(/from ['"].*\/(?:dsl|cel|parser)\.js['"]/);
    }
  });

  it('keeps the direct TypeScript compiler independent of YAML and CEL', () => {
    for (const file of ['compiler.ts', 'resourceModel.ts', 'composition.ts']) {
      const source = readFileSync(join(process.cwd(), 'src', 'authoring', file), 'utf8');
      expect(source).not.toMatch(/from ['"].*\/(?:dsl|parser|cel)\//);
      expect(source).not.toMatch(/from ['"].*\/(?:dsl|parser|cel)\.js['"]/);
    }
  });

  it('keeps YAML fault-wire parsing behind the runtime system boundary', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'http', 'runtimeGateway.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"].*\/parser\//);
    expect(source).not.toMatch(/from ['"].*\/authoring\//);
    expect(source).not.toContain('/_engine/dsl');
    expect(source).not.toContain('yamlReducerCount');
    expect(source).not.toContain('tsReducerCount');
  });

  it('keeps YAML runtime boot source-only and leaves parser transport wiring to parser/gateway', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'parser', 'runtime.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"].*\/http\//);
    expect(source).not.toContain('gatewayExtensions');
    expect(source).not.toContain('YamlRuntimeSystem');
  });

  it('keeps parser validation independent of the engine implementation module', () => {
    const parserRoot = join(process.cwd(), 'src', 'parser');
    for (const file of readdirSync(parserRoot).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(parserRoot, file), 'utf8');
      expect(source).not.toMatch(/from ['"].*\/core\/engine\.js['"]/);
    }
  });

  it('keeps the runtime coordinator on raw parser inputs, not YAML-linked inputs', () => {
    for (const file of ['system.ts']) {
      const source = readFileSync(join(process.cwd(), 'src', 'runtime', file), 'utf8');
      expect(source).not.toContain('YamlLinkedProgram');
      expect(source).not.toMatch(/from ['"].*\/dsl\//);
      expect(source).not.toContain('compileYamlModel');
    }
  });

  it('keeps runtime boot independent of the TypeScript authoring definition', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'runtime', 'system.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"].*\/authoring\//);
    expect(source).not.toContain('SimulationDefinition');
    expect(source).not.toContain('compileProgram');
  });

  it('keeps the package root independent of the historical coordinator', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');
    expect(source).not.toContain('YamlLinkedProgram');
    expect(source).not.toMatch(/from ['"].*\/dsl\//);
    expect(source).not.toMatch(/from ['"].*\/parser\//);
  });

  it('keeps canonical runtime import closures free of source parsers', () => {
    const roots = [
      'src/index.ts',
      'src/runtime/system.ts',
      'src/model/runtime.ts',
      'src/model/compiler.ts',
      'src/core/engine.ts',
      'src/authoring/compiler.ts',
      'src/authoring/resourceModel.ts',
      'src/authoring/composition.ts',
      'src/http/runtimeGateway.ts',
    ].map((file) => join(process.cwd(), file));
    const sourceRoot = resolve(process.cwd(), 'src');
    const forbidden = [
      join(sourceRoot, 'dsl') + sep,
      join(sourceRoot, 'cel') + sep,
      join(sourceRoot, 'parser') + sep,
    ];
    const violations = roots.flatMap((root) =>
      reachableLocalModules(root)
        .filter((file) => forbidden.some((fragment) => file.includes(fragment)))
        .map((file) => `${relative(process.cwd(), root)} -> ${relative(process.cwd(), file)}`),
    );
    expect(violations).toEqual([]);
  });
});
