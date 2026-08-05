import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('editor and TypeScript adapter boundaries', () => {
  it('keeps VS Code and IntelliJ on the same stdio language-server contract', () => {
    const root = process.cwd();
    const vscodeManifest = JSON.parse(
      readFileSync(path.join(root, 'editors/vscode/package.json'), 'utf8'),
    ) as { contributes?: { configuration?: unknown }; activationEvents?: readonly string[] };
    const vscodeExtension = readFileSync(path.join(root, 'editors/vscode/extension.js'), 'utf8');
    const intellijGuide = readFileSync(path.join(root, 'editors/intellij/README.md'), 'utf8');

    expect(vscodeManifest.activationEvents).toEqual(
      expect.arrayContaining(['onLanguage:yaml', 'onLanguage:typescript']),
    );
    expect(vscodeManifest.contributes?.configuration).toBeDefined();
    expect(vscodeExtension).toContain('potemkin-language-server');
    expect(vscodeExtension).toContain('TransportKind.stdio');
    expect(vscodeExtension).toContain("language: 'yaml'");
    expect(vscodeExtension).toContain("language: 'typescript'");
    expect(intellijGuide).toContain(
      'Command: /absolute/path/to/project/node_modules/.bin/potemkin-language-server',
    );
    expect(intellijGuide).toContain('Transport: stdio');
    expect(intellijGuide).toContain('Register YAML');
    expect(intellijGuide).toContain('TypeScript (`*.ts`, `*.tsx`)');
    expect(intellijGuide).toContain('potemkin.schema.json');
  });

  it('keeps the tsserver adapter limited to generation invalidation', () => {
    const plugin = readFileSync(
      path.join(rootForTests(), 'src/typescript-plugin/index.ts'),
      'utf8',
    );
    expect(plugin).toContain('watchConfiguredOpenApiBindings');
    expect(plugin).toContain('cleanupSemanticCache');
    expect(plugin).not.toMatch(/from ["'][^"']*model\//);
    expect(plugin).not.toMatch(/from ["'][^"']*runtime\//);
    expect(plugin).not.toMatch(/from ["'][^"']*openapi\//);
    expect(plugin).not.toContain('parseYaml');
    expect(plugin).not.toContain('RuntimeModel');
  });
});

function rootForTests(): string {
  return process.cwd();
}
