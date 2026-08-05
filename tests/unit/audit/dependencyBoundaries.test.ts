import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { ConsumerClient } from '../../../examples/_harness/consumer-client';

function sourceFiles(root: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const file = path.join(root, entry);
    if (statSync(file).isDirectory()) files.push(...sourceFiles(file));
    else if (/\.(ts|tsx|kt|kts)$/.test(file)) files.push(file);
  }
  return files;
}

function relativeSourceFiles(root: string): readonly [string, string][] {
  return sourceFiles(root).map((file) => [
    path.relative(process.cwd(), file),
    readFileSync(file, 'utf8'),
  ]);
}

function executableSource(source: string): string {
  return source.replace(/\/\/.*$/gm, '');
}

describe('dependency and legacy-surface boundaries', () => {
  it('contains no removed runtime surfaces or registration concepts', () => {
    const roots = [path.resolve(process.cwd(), 'src'), path.resolve(process.cwd(), 'plugin')];
    const pathViolations = roots
      .flatMap((root) => sourceFiles(root))
      .filter((file) => /(?:adapter|shim|legacy|compat)/i.test(path.basename(file)))
      .map((file) => `${path.relative(process.cwd(), file)}: removed surface filename`);
    const sourceViolations = roots.flatMap((root) =>
      relativeSourceFiles(root).flatMap(([file, source]) => {
        const matches = [
          /runtimeAdapter/i,
          /runtime adapter/i,
          /@Script\b/,
          /compatibility\s+alias/i,
          /alias\s+compatibility/i,
          /compatibility boot/i,
          /backward compat/i,
          /backwards compat/i,
          /\bshim\b/i,
        ].filter((pattern) => pattern.test(source));
        return matches.map((pattern) => `${file}: ${pattern}`);
      }),
    );
    expect([...pathViolations, ...sourceViolations]).toEqual([]);
  });

  it('keeps configuration contracts in the foundation contracts module', () => {
    const configPath = path.resolve(process.cwd(), 'src', 'config.ts');
    const contractsPath = path.resolve(process.cwd(), 'src', 'contracts', 'config.ts');
    const configSource = readFileSync(configPath, 'utf8');
    const contractsSource = readFileSync(contractsPath, 'utf8');
    const configurationInterfaces =
      /export interface (?:Scan|Plugin|Seed|Workflow|Overlay|Governance|Potemkin|EngineConfiguration)/;

    expect(configSource).not.toMatch(configurationInterfaces);
    expect(contractsSource).toMatch(/export interface PotemkinConfiguration/);
    expect(contractsSource).toMatch(/export interface EngineConfigurationResponse/);

    const typeImportsFromConfigurationImplementation = relativeSourceFiles(
      path.resolve(process.cwd(), 'src'),
    )
      .filter(([file]) => file !== 'src/config.ts' && file !== 'src/index.ts')
      .filter(([, source]) => /import type[\s\S]*from ["'](?:\.\.?\/)+config\.js["']/.test(source))
      .map(([file]) => file);
    expect(typeImportsFromConfigurationImplementation).toEqual([]);
  });

  it('keeps OpenAPI document contracts out of the broad value-types module', () => {
    const valueTypes = readFileSync(path.resolve(process.cwd(), 'src', 'types.ts'), 'utf8');
    const openapiContracts = readFileSync(
      path.resolve(process.cwd(), 'src', 'contracts', 'openapi.ts'),
      'utf8',
    );

    expect(valueTypes).not.toMatch(/export interface OpenApi(?:Document|Operation)Descriptor/);
    expect(openapiContracts).toMatch(/export interface OpenApiDocumentDescriptor/);
    expect(
      relativeSourceFiles(path.resolve(process.cwd(), 'src')).filter(([file, source]) =>
        importsNamedFrom(source, file, '../types.js', [
          'OpenApiDocumentDescriptor',
          'OpenApiOperationDescriptor',
        ]),
      ),
    ).toEqual([]);
  });

  it('keeps JSON, patch, and readonly value contracts in contracts/value', () => {
    const legacyTypes = readFileSync(path.resolve(process.cwd(), 'src', 'types.ts'), 'utf8');
    const valueContracts = readFileSync(
      path.resolve(process.cwd(), 'src', 'contracts', 'value.ts'),
      'utf8',
    );
    const valueNames = [
      'JsonScalar',
      'JsonArray',
      'JsonObject',
      'JsonValue',
      'PatchSource',
      'Patch',
      'DeepReadonly',
    ];

    expect(legacyTypes).not.toMatch(/export (?:type|interface) (?:Json|Patch|DeepReadonly)/);
    for (const name of valueNames) {
      expect(valueContracts).toMatch(new RegExp(`export (?:type|interface) ${name}\\b`));
    }
    expect(
      relativeSourceFiles(path.resolve(process.cwd(), 'src')).filter(([file, source]) =>
        importsNamedFrom(source, file, '../types.js', valueNames),
      ),
    ).toEqual([]);
  });

  it('keeps domain, identity, and lifecycle values in canonical foundation contracts', () => {
    const legacyTypes = readFileSync(path.resolve(process.cwd(), 'src', 'types.ts'), 'utf8');
    const domainContracts = readFileSync(
      path.resolve(process.cwd(), 'src', 'contracts', 'domain.ts'),
      'utf8',
    );
    const identityContracts = readFileSync(
      path.resolve(process.cwd(), 'src', 'contracts', 'identity.ts'),
      'utf8',
    );
    const domainNames = [
      'Intent',
      'Origin',
      'Command',
      'EventRequestSnapshot',
      'EventResponseSnapshot',
      'DomainEvent',
      'ExecutionResult',
    ];
    const identityNames = ['Actor', 'JwtValidationConfig'];

    expect(legacyTypes).not.toMatch(
      /export (?:type|interface) (?:Intent|Origin|Actor|Command|EventRequestSnapshot|EventResponseSnapshot|DomainEvent|ExecutionResult|JwtValidationConfig)\b/,
    );
    for (const name of domainNames) {
      expect(domainContracts).toMatch(new RegExp(`export (?:type|interface) ${name}\\b`));
    }
    for (const name of identityNames) {
      expect(identityContracts).toMatch(new RegExp(`export interface ${name}\\b`));
    }
    expect(
      relativeSourceFiles(path.resolve(process.cwd(), 'src')).filter(([file, source]) =>
        importsNamedFrom(source, file, '../types.js', [...domainNames, ...identityNames]),
      ),
    ).toEqual([]);
  });

  it('keeps complete request controls in the transport-neutral contract module', () => {
    const valueTypes = readFileSync(path.resolve(process.cwd(), 'src', 'types.ts'), 'utf8');
    const controlContracts = readFileSync(
      path.resolve(process.cwd(), 'src', 'contracts', 'controlHeaders.ts'),
      'utf8',
    );

    expect(valueTypes).not.toMatch(/export (?:interface RequestControls|type ErrorClass)/);
    expect(controlContracts).toMatch(/export interface RequestControls/);
    expect(controlContracts).toMatch(/export type ErrorClass/);
    expect(
      relativeSourceFiles(path.resolve(process.cwd(), 'src')).filter(([file, source]) =>
        importsNamedFrom(source, file, '../types.js', ['RequestControls', 'ErrorClass']),
      ),
    ).toEqual([]);
  });

  it('keeps data generation and lifecycle notifications in foundation contracts', () => {
    const legacyTypes = readFileSync(path.resolve(process.cwd(), 'src', 'types.ts'), 'utf8');
    const dataContracts = readFileSync(
      path.resolve(process.cwd(), 'src', 'contracts', 'data.ts'),
      'utf8',
    );
    const lifecycleContracts = readFileSync(
      path.resolve(process.cwd(), 'src', 'contracts', 'lifecycle.ts'),
      'utf8',
    );

    expect(legacyTypes).not.toMatch(/export (?:type|interface) (?:DataFormat|DataGenerator)\b/);
    expect(dataContracts).toMatch(/export type DataFormat\b/);
    expect(dataContracts).toMatch(/export interface DataGenerator\b/);
    expect(lifecycleContracts).toMatch(/export interface ReadyNotification\b/);
    expect(lifecycleContracts).toMatch(/export interface PluginControlClient\b/);
    expect(relativeSourceFiles(path.resolve(process.cwd(), 'src'))).not.toEqual(
      expect.arrayContaining([
        expect.arrayContaining([expect.any(String), expect.stringContaining('lifecycle/types.js')]),
      ]),
    );
  });

  it('keeps runtime effect ports in the dependency-free contracts layer', () => {
    const runtimeModel = readFileSync(
      path.resolve(process.cwd(), 'src', 'model', 'runtime.ts'),
      'utf8',
    );
    const ports = readFileSync(path.resolve(process.cwd(), 'src', 'contracts', 'ports.ts'), 'utf8');
    const portNames = [
      'RuntimeEventStore',
      'RuntimeStateStore',
      'RuntimeIdempotencyStore',
      'RuntimeClock',
      'RuntimeSessionStore',
      'RuntimeWebhookTransport',
      'RuntimeForwardingPort',
      'RuntimeObservability',
    ];

    expect(runtimeModel).not.toMatch(
      /export interface (?:RuntimeEventStore|RuntimeStateStore|RuntimeClock|RuntimeObservability)\b/,
    );
    for (const name of portNames) expect(ports).toMatch(new RegExp(`export interface ${name}\\b`));
    expect(ports).not.toMatch(
      /from ["'][^"']*(?:runtime|http|parser|yaml|cel|cli|editor)[^"']*["']/,
    );
  });

  it('keeps generation orchestration independent of runtime and protocol adapters', () => {
    const generationSources = relativeSourceFiles(path.resolve(process.cwd(), 'src', 'generation'));
    const forbidden =
      /from ["'][^"']*(?:runtime|http|language-server|typescript-plugin|vscode-languageserver)[^"']*["']/;
    expect(generationSources.filter(([, source]) => forbidden.test(source))).toEqual([]);

    for (const file of [
      'src/cli/generate-types.ts',
      'src/language-server/service.ts',
      'src/typescript-plugin/index.ts',
    ]) {
      const source = readFileSync(path.resolve(process.cwd(), file), 'utf8');
      expect(source).not.toMatch(/from ["'][^"']*openapi\/(?:bindings|yamlSchema)\.js["']/);
      expect(source).toMatch(/from ["'][^"']*generation\/(?:service|index)\.js["']/);
    }
  });

  it('keeps source locations and diagnostic severity in foundation contracts', () => {
    const diagnosticsSource = readFileSync(
      path.resolve(process.cwd(), 'src', 'contracts', 'diagnostics.ts'),
      'utf8',
    );
    const scenarioSource = readFileSync(
      path.resolve(process.cwd(), 'src', 'openapi', 'scenarioModel.ts'),
      'utf8',
    );
    expect(diagnosticsSource).toMatch(/export interface SourceLocation/);
    expect(diagnosticsSource).toMatch(/export type DiagnosticSeverity/);
    expect(scenarioSource).not.toMatch(/interface ScenarioSourceLocation\s*\{[^}]*sourcePath/);
    expect(scenarioSource).toMatch(/from ["']\.\.\/contracts\/diagnostics\.js["']/);
  });

  it('keeps process-environment reads at executable composition boundaries', () => {
    const allowed = new Set([
      'src/cli/server.ts',
      'src/conformance/cli.ts',
      'src/conformance/exampleStack.ts',
      'src/conformance/specmaticProcess.ts',
      'src/http/bindHost.ts',
    ]);
    const violations = relativeSourceFiles(path.resolve(process.cwd(), 'src'))
      .filter(([file, source]) => /process\.env/.test(source) && !allowed.has(file))
      .map(([file]) => file);
    expect(violations).toEqual([]);
  });

  it('keeps native time, randomness, and timer access in documented providers', () => {
    const allowed = new Set([
      'src/cel/builtins.ts',
      'src/cel/evaluator.ts',
      'src/core/engine.ts',
      'src/lifecycle/gracefulShutdown.ts',
      'src/parser/configuredWatcher.ts',
      'src/generation/service.ts',
      'src/conformance/exampleStack.ts',
      'src/conformance/specmaticProcess.ts',
      'src/runtime/host.ts',
    ]);
    const patterns = [
      /Date\.now\(/,
      /Math\.random\(/,
      /(?<![A-Za-z.])set(?:Interval|Timeout)\(/,
      /(?<![A-Za-z.])clear(?:Interval|Timeout)\(/,
    ];
    const violations = relativeSourceFiles(path.resolve(process.cwd(), 'src'))
      .filter(
        ([file, source]) =>
          patterns.some((pattern) => pattern.test(executableSource(source))) && !allowed.has(file),
      )
      .map(([file]) => file);
    expect(violations).toEqual([]);
  });

  it('does not introduce static implementation methods outside the discovery contract', () => {
    const violations = relativeSourceFiles(path.resolve(process.cwd(), 'src')).flatMap(
      ([file, source]) => {
        const sourceFile = ts.createSourceFile(
          file,
          source,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS,
        );
        const found: string[] = [];

        const visit = (node: ts.Node): void => {
          if (ts.isMethodDeclaration(node) && hasStaticModifier(node)) {
            const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
            const isDiscoveryMethod = decorators?.some((decorator) => {
              const expression = decorator.expression;
              return (
                ts.isCallExpression(expression) &&
                ts.isIdentifier(expression.expression) &&
                expression.expression.text === 'PotemkinConfigure'
              );
            });
            if (!isDiscoveryMethod) {
              found.push(`${file}:${sourceFile.getLineAndCharacterOfPosition(node.pos).line + 1}`);
            }
          }
          ts.forEachChild(node, visit);
        };

        visit(sourceFile);
        return found;
      },
    );
    expect(violations).toEqual([]);
  });

  it('keeps Specmatic/conformance infrastructure out of test and example support paths', () => {
    const root = path.resolve(process.cwd(), 'src', 'conformance');
    const violations = relativeSourceFiles(root)
      .filter(([, source]) => /from\s+["'][^"']*(?:tests|examples)[^"']*["']/.test(source))
      .map(([file]) => file);
    expect(violations).toEqual([]);
  });

  it('keeps Stripe behavior tests contract-backed and network-free', () => {
    const roots = [
      path.resolve(process.cwd(), 'tests', 'equivalence'),
      path.resolve(process.cwd(), 'tests', 'integration', 'equivalence'),
      path.resolve(process.cwd(), 'tests', 'unit', 'equivalence'),
      path.resolve(process.cwd(), 'examples', 'stripe', 'tests'),
      path.resolve(process.cwd(), 'examples', 'stripe', 'typescript'),
      path.resolve(process.cwd(), 'examples', '_harness'),
    ];
    const forbidden =
      /api\.stripe\.com|STRIPE_TEST_API_KEY|STRIPE_API_KEY|\/v1\/events|from\s+["']stripe["']|require\(["']stripe["']\)/i;
    const violations = roots
      .flatMap((root) => relativeSourceFiles(root))
      .filter(([, source]) => forbidden.test(source))
      .map(([file]) => file);
    expect(violations).toEqual([]);
  });

  it('makes the consumer harness loopback-only', () => {
    expect(() => new ConsumerClient('https://provider.invalid')).toThrow(
      'only permits loopback HTTP endpoints',
    );
    expect(() => new ConsumerClient('http://127.0.0.1:8080')).not.toThrow();
  });

  it('rejects provider URLs supplied as request paths', async () => {
    const client = new ConsumerClient('http://127.0.0.1:8080');
    await expect(client.get('https://provider.invalid/v1/customers')).rejects.toThrow(
      'only permits loopback HTTP endpoints',
    );
  });
});

function hasStaticModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) === true;
}

function importsNamedFrom(
  source: string,
  file: string,
  modulePath: string,
  names: readonly string[],
): boolean {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || !ts.isImportDeclaration(node)) {
      ts.forEachChild(node, visit);
      return;
    }
    if (!ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== modulePath) {
      ts.forEachChild(node, visit);
      return;
    }
    const bindings = node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) {
      ts.forEachChild(node, visit);
      return;
    }
    found = bindings.elements.some((element) =>
      names.includes(element.propertyName?.text ?? element.name.text),
    );
  };
  visit(sourceFile);
  return found;
}
