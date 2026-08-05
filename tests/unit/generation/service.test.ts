import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { watchConfiguredOpenApiBindings } from '../../../src/generation/service.js';

jest.mock('openapi-typescript', () => ({
  __esModule: true,
  default: async () => [],
  astToString: () => 'export interface paths {}\nexport interface components {}',
}));

describe('configured generated-artifact watcher', () => {
  it('regenerates OpenAPI types, SDK types, and YAML schema when any source changes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-generation-watch-'));
    const updates: string[] = [];
    let watcher: Awaited<ReturnType<typeof watchConfiguredOpenApiBindings>> | undefined;
    try {
      await fs.mkdir(path.join(root, 'dsl'));
      await fs.mkdir(path.join(root, 'typescript'));
      const configPath = path.join(root, 'potemkin.yml');
      const openapiPath = path.join(root, 'openapi.yaml');
      const yamlPath = path.join(root, 'dsl', 'agent.yaml');
      const typescriptPath = path.join(root, 'typescript', 'events.ts');

      await fs.writeFile(openapiPath, openapiDocument('createAgent'), 'utf8');
      await fs.writeFile(yamlPath, yamlModule('YamlCreated'), 'utf8');
      await fs.writeFile(typescriptPath, typescriptModule('TypeScriptCreated'), 'utf8');
      await fs.writeFile(
        configPath,
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

      watcher = await watchConfiguredOpenApiBindings({
        configPath,
        projectRoot: root,
        outputDirectory: path.join(root, 'generated'),
        intervalMs: 20,
        onUpdate: (result) => updates.push(result.hash),
      });

      expect(updates).toHaveLength(1);
      await assertGeneratedArtifacts(watcher, ['createAgent', 'YamlCreated', 'TypeScriptCreated']);

      await fs.writeFile(yamlPath, yamlModule('YamlRenamedWithLongerName'), 'utf8');
      await waitFor(async () => {
        const sdk = await fs.readFile(watcher!.sdkOutputFile, 'utf8');
        return sdk.includes('YamlRenamedWithLongerName');
      });
      await waitFor(() => updates.length >= 2);
      expect(updates).toHaveLength(2);
      await assertGeneratedArtifacts(watcher, [
        'createAgent',
        'YamlRenamedWithLongerName',
        'TypeScriptCreated',
      ]);

      await fs.writeFile(
        typescriptPath,
        typescriptModule('TypeScriptRenamedWithLongerName'),
        'utf8',
      );
      await waitFor(async () => {
        const sdk = await fs.readFile(watcher!.sdkOutputFile, 'utf8');
        return sdk.includes('TypeScriptRenamedWithLongerName');
      });
      await waitFor(() => updates.length >= 3);
      expect(updates).toHaveLength(3);
      await assertGeneratedArtifacts(watcher, [
        'createAgent',
        'YamlRenamedWithLongerName',
        'TypeScriptRenamedWithLongerName',
      ]);

      await fs.writeFile(openapiPath, openapiDocument('createAgentWithLongerName'), 'utf8');
      await waitFor(async () => {
        const sdk = await fs.readFile(watcher!.sdkOutputFile, 'utf8');
        return sdk.includes('createAgentWithLongerName');
      });
      await waitFor(() => updates.length >= 4);
      expect(updates).toHaveLength(4);
      await assertGeneratedArtifacts(watcher, [
        'createAgentWithLongerName',
        'YamlRenamedWithLongerName',
        'TypeScriptRenamedWithLongerName',
      ]);
    } finally {
      watcher?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reports source failures and continues watching after a broken edit', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-generation-watch-error-'));
    const errors: unknown[] = [];
    let watcher: Awaited<ReturnType<typeof watchConfiguredOpenApiBindings>> | undefined;
    try {
      await fs.mkdir(path.join(root, 'dsl'));
      const configPath = path.join(root, 'potemkin.yml');
      const openapiPath = path.join(root, 'openapi.yaml');
      await fs.writeFile(path.join(root, 'dsl', 'agent.yaml'), yamlModule('YamlCreated'), 'utf8');
      await fs.writeFile(openapiPath, openapiDocument('createAgent'), 'utf8');
      await fs.writeFile(
        configPath,
        [
          'version: 1',
          'specmatic: specmatic.yaml',
          'openapi:',
          '  - openapi.yaml',
          'modules:',
          '  - dsl/*.yaml',
        ].join('\n'),
        'utf8',
      );

      watcher = await watchConfiguredOpenApiBindings({
        configPath,
        projectRoot: root,
        outputDirectory: path.join(root, 'generated'),
        intervalMs: 20,
        onError: (error) => errors.push(error),
      });
      const initialSdk = await fs.readFile(watcher.sdkOutputFile, 'utf8');
      expect(initialSdk).toContain('createAgent');

      await fs.writeFile(openapiPath, 'openapi: [broken', 'utf8');
      await waitFor(() => errors.length > 0);
      expect(await fs.readFile(watcher.sdkOutputFile, 'utf8')).toContain('createAgent');

      await fs.writeFile(openapiPath, openapiDocument('createAgentRecovered'), 'utf8');
      await waitFor(async () => {
        const sdk = await fs.readFile(watcher!.sdkOutputFile, 'utf8');
        return sdk.includes('createAgentRecovered');
      });
    } finally {
      watcher?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

async function assertGeneratedArtifacts(
  watcher: Awaited<ReturnType<typeof watchConfiguredOpenApiBindings>>,
  expected: readonly string[],
): Promise<void> {
  const openapiTypes = await fs.readFile(watcher.outputFile, 'utf8');
  const sdk = await fs.readFile(watcher.sdkOutputFile, 'utf8');
  const schema = await fs.readFile(watcher.yamlSchemaFile, 'utf8');
  for (const value of expected) {
    expect(openapiTypes + sdk + schema).toContain(value);
  }
}

function openapiDocument(operationId: string): string {
  return [
    'openapi: 3.0.3',
    'info: { title: Generated bindings, version: "1.0.0" }',
    'paths:',
    '  /agents:',
    '    post:',
    `      operationId: ${operationId}`,
    '      responses:',
    '        "201": { description: Created }',
  ].join('\n');
}

function yamlModule(eventType: string): string {
  return [
    'boundary: Agent',
    'contract_path: /agents',
    'event_catalog:',
    `  - type: ${eventType}`,
    '    payload_template: { id: "$uuidv7()" }',
    'behaviors: []',
    'reducers: []',
  ].join('\n');
}

function typescriptModule(eventType: string): string {
  return `event(eventType("${eventType}"), { id: "id" });\n`;
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('Timed out waiting for generated artifact update');
}
