import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadOpenApi } from '../../src/contract/loader.js';
import { generateOpenApiBindings } from '../../src/openapi/bindings.js';
import { collectScenarioModel } from '../../src/openapi/scenarioModel.js';
import { generatePotemkinYamlSchema } from '../../src/openapi/yamlSchema.js';

// The real openapi-typescript ESM graph is exercised by the CLI/build smoke
// path; this E2E test exercises the complete Potemkin generation/write/link
// pipeline under the repository's CommonJS Jest E2E harness.
jest.mock('openapi-typescript', () => ({
  __esModule: true,
  default: async () => [],
  astToString: () =>
    'export interface paths {}\nexport interface components {}\nexport interface operations {}',
}));

describe('generated OpenAPI and SDK bindings', () => {
  it('links contract paths, schemas, operations, qualified events, and payloads end to end', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-generated-bindings-e2e-'));
    try {
      const openapi = await loadOpenApi({
        openapi: '3.0.3',
        info: { title: 'Generated bindings', version: '1.0.0' },
        paths: {
          '/agents': {
            post: {
              operationId: 'createAgent',
              requestBody: {
                required: true,
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/AgentInput' } },
                },
              },
              responses: {
                '201': {
                  description: 'Created',
                  content: {
                    'application/json': { schema: { $ref: '#/components/schemas/Agent' } },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            AgentInput: {
              type: 'object',
              required: ['name'],
              properties: { name: { type: 'string' } },
            },
            Agent: {
              type: 'object',
              required: ['id'],
              properties: { id: { type: 'string' }, name: { type: 'string' } },
            },
          },
        },
      });
      const model = await collectScenarioModel(openapi, {
        potemkinConfigPath: path.join(root, 'potemkin.yml'),
        configuration: { version: 1, specmatic: 'specmatic.yaml', modules: [] },
        yamlProgram: {
          modules: [
            {
              name: path.join(root, 'agent.yaml'),
              yaml: [
                'boundary: Agent',
                'contract_path: /agents',
                'event_catalog:',
                '  - type: AgentCreated',
                "    schema_ref: '#/components/schemas/Agent'",
                '    payload_template: { id: event.payload.id }',
                'behaviors: []',
                'reducers: []',
              ].join('\n'),
            },
          ],
        },
      } as never);
      const generated = await generateOpenApiBindings(openapi, {
        outputDirectory: root,
        scenario: model,
      });
      const generatedSchema = await generatePotemkinYamlSchema({
        openapi,
        loaded: {
          configuration: { version: 1, specmatic: 'specmatic.yaml', modules: [] },
          yamlProgram: { modules: [] },
          boundaryModulePaths: [],
          componentModulePaths: [],
          useMappingModulePaths: [],
          globalModulePaths: [],
        } as never,
        outputDirectory: root,
        scenario: model,
      });
      const sdk = await fs.readFile(generated.sdkOutputFile, 'utf8');
      const openapiTypes = await fs.readFile(generated.outputFile, 'utf8');
      const schema = JSON.parse(await fs.readFile(generatedSchema.outputFile, 'utf8')) as Record<
        string,
        unknown
      >;

      expect(openapiTypes).toContain('export type Path = keyof paths & string;');
      expect(openapiTypes).toContain(
        'export type SchemaReference = `#/components/schemas/${SchemaName}`;',
      );
      expect(sdk).toContain('readonly "/agents": true;');
      expect(sdk).toContain('readonly "createAgent"');
      expect(sdk).toContain('OperationRequestBody<"createAgent">');
      expect(sdk).toContain('OperationResponses<"createAgent">');
      expect(sdk).toContain('readonly "AgentCreated": import("potemkin/openapi").Schema<"Agent">');
      expect(sdk).toContain(
        'readonly "Agent:AgentCreated": import("potemkin/openapi").Schema<"Agent">',
      );
      expect(schema).toMatchObject({
        $defs: { jsonValue: expect.any(Object) },
        description: expect.stringContaining('Generated'),
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
