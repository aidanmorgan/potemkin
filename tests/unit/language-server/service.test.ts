import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { TextDocument } from 'vscode-languageserver-textdocument';

import { PotemkinLanguageService } from '../../../src/language-server/service.js';

jest.mock('openapi-typescript', () => ({
  __esModule: true,
  default: async () => [],
  astToString: () =>
    'export interface paths {}\nexport interface operations { createAgent: unknown; }',
}));

describe('unified Potemkin language service', () => {
  it('merges unsaved YAML and TypeScript events for diagnostics, completion, and definitions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-language-server-'));
    try {
      await fs.mkdir(path.join(root, 'dsl'));
      await fs.mkdir(path.join(root, 'typescript'));
      await fs.writeFile(
        path.join(root, 'openapi.yaml'),
        [
          'openapi: 3.0.3',
          'info:',
          '  title: Language service',
          '  version: "1.0.0"',
          'paths:',
          '  /agents:',
          '    post:',
          '      operationId: createAgent',
          '      responses:',
          "        '201':",
          '          description: Created',
        ].join('\n'),
        'utf8',
      );
      await fs.writeFile(
        path.join(root, 'potemkin.yml'),
        [
          'version: 1',
          'specmatic: specmatic.yaml',
          'modules:',
          '  - dsl/*.yaml',
          'openapi:',
          '  - openapi.yaml',
          'typescript:',
          '  scan:',
          '    - include:',
          '        - typescript/*.ts',
        ].join('\n'),
        'utf8',
      );
      const yamlPath = path.join(root, 'dsl', 'agent.yaml');
      await fs.writeFile(yamlPath, yamlModule(), 'utf8');
      await fs.writeFile(
        path.join(root, 'dsl', 'shared-component.yaml'),
        [
          'kind: component',
          'name: SharedAgent',
          'event_catalog:',
          '  - type: SharedAgentCreated',
        ].join('\n'),
        'utf8',
      );
      const usePath = path.join(root, 'dsl', 'use.yaml');
      await fs.writeFile(usePath, 'use:\n  - component: MissingComponent\n', 'utf8');
      const typescriptPath = path.join(root, 'typescript', 'simulation.ts');
      await fs.writeFile(typescriptPath, 'export const source = true;', 'utf8');

      const service = new PotemkinLanguageService({ workspacePath: root });
      const yamlDocument = TextDocument.create(
        `file://${yamlPath}`,
        'yaml',
        1,
        yamlModule().replace('emit: YamlCreated', 'emit: MissingEvent'),
      );
      service.open(yamlDocument, 'yaml');
      const initialDiagnostics = await service.diagnostics(yamlDocument);
      expect(initialDiagnostics.map((entry) => entry.message)).toContain(
        'Unknown scenario event "MissingEvent"',
      );
      const unknownOperationDocument = TextDocument.create(
        `file://${yamlPath}`,
        'yaml',
        1,
        yamlModule().replace('operationId: createAgent', 'operationId: missingOperation'),
      );
      const unknownOperationDiagnostics = await service.diagnostics(unknownOperationDocument);
      expect(unknownOperationDiagnostics.map((entry) => entry.message)).toContain(
        'Unknown OpenAPI operationId "missingOperation"',
      );

      const typescriptText = 'eventType("YamlCreated");\neventType("MissingEvent");';
      const typescriptDocument = TextDocument.create(
        `file://${typescriptPath}`,
        'typescript',
        1,
        typescriptText,
      );
      service.open(typescriptDocument, 'typescript');
      const typescriptDiagnostics = await service.diagnostics(typescriptDocument);
      expect(typescriptDiagnostics.map((entry) => entry.message)).toContain(
        'Unknown scenario event "MissingEvent"',
      );

      const completions = await service.completions(
        TextDocument.create(`file://${typescriptPath}`, 'typescript', 2, 'eventType("'),
        { line: 0, character: 11 },
      );
      expect(completions.map((entry) => entry.label)).toContain('YamlCreated');

      const componentCompletions = await service.completions(
        TextDocument.create(`file://${typescriptPath}`, 'typescript', 2, 'componentName("'),
        { line: 0, character: 15 },
      );
      expect(componentCompletions.map((entry) => entry.label)).toContain('SharedAgent');

      const behaviorCompletions = await service.completions(
        TextDocument.create(`file://${typescriptPath}`, 'typescript', 2, 'behaviorName("'),
        { line: 0, character: 15 },
      );
      expect(behaviorCompletions.map((entry) => entry.label)).toContain('create');

      const payloadCompletions = await service.completions(
        TextDocument.create(`file://${yamlPath}`, 'yaml', 2, 'payload_template: '),
        { line: 0, character: 18 },
      );
      expect(payloadCompletions.map((entry) => entry.label)).toContain('id');

      const configPath = path.join(root, 'potemkin.yml');
      const configDocument = TextDocument.create(
        `file://${configPath}`,
        'yaml',
        2,
        [
          'version: 1',
          'specmatic: specmatic.yaml',
          'modules:',
          '  - dsl/*.yaml',
          'plugin:',
          '  ',
        ].join('\n'),
      );
      service.open(configDocument, 'yaml');
      const pluginCompletions = await service.completions(configDocument, {
        line: 5,
        character: 2,
      });
      expect(pluginCompletions.map((entry) => entry.label)).toEqual(
        expect.arrayContaining(['controlPort', 'healthProbe', 'auth']),
      );
      service.close(configDocument.uri);

      const useDocument = TextDocument.create(
        `file://${usePath}`,
        'yaml',
        1,
        await fs.readFile(usePath, 'utf8'),
      );
      expect((await service.diagnostics(useDocument)).map((entry) => entry.message)).toContain(
        'Unknown scenario component "MissingComponent"',
      );

      const definition = await service.definition(typescriptDocument, { line: 0, character: 12 });
      expect(definition?.uri).toBe(`file://${yamlPath}`);

      const references = await service.references(typescriptDocument, { line: 0, character: 12 });
      expect(references.length).toBeGreaterThanOrEqual(2);
      const rename = await service.rename(
        typescriptDocument,
        { line: 0, character: 12 },
        'RenamedEvent',
      );
      expect(rename?.changes?.[`file://${yamlPath}`]?.length).toBeGreaterThan(0);
      expect(
        (await service.hover(typescriptDocument, { line: 0, character: 12 }))?.contents,
      ).toEqual(expect.objectContaining({ kind: 'markdown' }));
      expect((await service.workspaceSymbols('Yaml'))[0]?.name).toBe('YamlCreated');

      const initialSnapshot = await service.refresh();
      expect(initialSnapshot).toBeDefined();
      expect(await fs.readFile(initialSnapshot!.bindings.yamlSchema.outputFile, 'utf8')).toContain(
        'YamlCreated',
      );
      expect(await fs.readFile(initialSnapshot!.bindings.sdkOutputFile, 'utf8')).toContain(
        'YamlCreated',
      );
      expect(await fs.readFile(initialSnapshot!.bindings.outputFile, 'utf8')).toContain(
        'createAgent',
      );
      const changedYaml = TextDocument.create(
        `file://${yamlPath}`,
        'yaml',
        3,
        yamlModule().replace('YamlCreated', 'RenamedCreated'),
      );
      service.change(changedYaml, 'yaml');
      const refreshedSnapshot = await service.refresh();
      expect(refreshedSnapshot).toBeDefined();
      expect(
        await fs.readFile(refreshedSnapshot!.bindings.yamlSchema.outputFile, 'utf8'),
      ).toContain('RenamedCreated');
      expect(await fs.readFile(refreshedSnapshot!.bindings.sdkOutputFile, 'utf8')).toContain(
        'RenamedCreated',
      );

      const changedTypescriptDocument = TextDocument.create(
        `file://${typescriptPath}`,
        'typescript',
        3,
        'eventType("RenamedCreated");\neventType("YamlCreated");',
      );
      const changedTypescriptDiagnostics = await service.diagnostics(changedTypescriptDocument);
      const changedMessages = changedTypescriptDiagnostics.map((entry) => entry.message);
      expect(changedMessages).not.toContain('Unknown scenario event "RenamedCreated"');
      expect(changedMessages).toContain('Unknown scenario event "YamlCreated"');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

function yamlModule(): string {
  return [
    'boundary: Agent',
    'contract_path: /agents',
    'event_catalog:',
    '  - type: YamlCreated',
    '    payload_template:',
    "      id: '$uuidv7()'",
    'behaviors:',
    '  - name: create',
    '    match:',
    '      operationId: createAgent',
    "      condition: 'true'",
    '    emit: YamlCreated',
  ].join('\n');
}
