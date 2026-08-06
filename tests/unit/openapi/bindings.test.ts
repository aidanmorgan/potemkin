import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import * as ts from 'typescript';
import Ajv from 'ajv';
import { loadOpenApi } from '../../../src/contract/loader.js';
import { generateOpenApiBindings } from '../../../src/openapi/bindings.js';
import { collectScenarioModel } from '../../../src/openapi/scenarioModel.js';
import { generatePotemkinYamlSchema } from '../../../src/openapi/yamlSchema.js';

// openapi-typescript's current dependency graph includes ESM-only helpers that
// Jest's CommonJS runner does not transform. The real generator is exercised by
// the CLI smoke check; this unit test isolates the Potemkin template/write layer.
jest.mock('openapi-typescript', () => ({
  __esModule: true,
  default: async () => [],
  astToString: () =>
    'export interface paths {}\nexport interface components {}\nexport interface operations { getAgent: unknown; }',
}));

describe('OpenAPI TypeScript bindings', () => {
  it('generates stable ambient module bindings and skips unchanged writes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-bindings-'));
    try {
      const document = await loadOpenApi({
        openapi: '3.0.3',
        info: { title: 'Bindings', version: '1.0.0' },
        paths: {
          '/agents/{id}': {
            get: {
              operationId: 'getAgent',
              parameters: [
                {
                  name: 'id',
                  in: 'path',
                  required: true,
                  schema: { type: 'string' },
                },
              ],
              responses: {
                '200': {
                  description: 'Agent',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['id'],
                        properties: { id: { type: 'string' } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });

      const first = await generateOpenApiBindings(document, { outputDirectory: root });
      const second = await generateOpenApiBindings(document, { outputDirectory: root });
      const generated = await fs.readFile(first.outputFile, 'utf8');

      expect(first.changed).toBe(true);
      expect(second.changed).toBe(false);
      expect(generated).toContain('declare module "potemkin/openapi"');
      expect(generated).toContain('getAgent');
      expect(generated).toContain('export type Path = keyof paths & string;');
      expect(generated).toContain('export type SchemaName');
      expect(generated).toContain(
        'export type SchemaReference = `#/components/schemas/${SchemaName}`;',
      );
      expect(generated).toContain('OperationRequestBody');
      expect(generated).toContain('OperationResponse');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an unsupported source document before calling openapi-typescript', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-bindings-invalid-'));
    try {
      await expect(
        generateOpenApiBindings(
          {
            source: {
              swagger: '2.0',
              info: { title: 'Swagger', version: '1.0.0' },
              paths: {},
            },
            raw: {},
            paths: {},
          },
          { outputDirectory: root },
        ),
      ).rejects.toThrow('requires an OpenAPI 3 document');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('emits inferred event payload and operation registries for the SDK', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-typed-bindings-'));
    try {
      const document = await loadOpenApi({
        openapi: '3.0.3',
        info: { title: 'Typed', version: '1.0.0' },
        paths: { '/agents': { post: { operationId: 'createAgent', responses: {} } } },
      });
      const result = await generateOpenApiBindings(document, {
        outputDirectory: root,
        scenario: {
          paths: ['/agents'],
          operationIds: ['createAgent'],
          schemas: ['Agent'],
          eventTypes: ['AgentCreated'],
          eventSelectors: ['AgentCreated'],
          events: [
            {
              boundary: 'Agent',
              type: 'AgentCreated',
              fields: ['id', 'active'],
              fieldTypes: { id: 'string', active: 'boolean' },
            },
            {
              boundary: 'Agent',
              type: 'SchemaEvent',
              fields: [],
              schemaRef: '#/components/schemas/Agent',
            },
          ],
          references: [],
          diagnostics: [],
          behaviors: [],
          reducers: [],
          queries: [],
          reactions: [],
          projections: [],
          sagas: [],
          webhooks: [],
          uses: [],
          projectFeatures: [],
          policies: { global: {} },
        },
      });
      expect(await fs.readFile(result.sdkOutputFile, 'utf8')).toContain('readonly "createAgent"');
      const sdk = await fs.readFile(result.sdkOutputFile, 'utf8');
      expect(sdk).toContain('readonly "createAgent"');
      expect(sdk).toContain('readonly "Agent:AgentCreated"');
      expect(sdk).toContain('readonly path: "/agents"');
      expect(sdk).toContain('readonly "/agents": true;');
      expect(sdk).toContain('readonly "Agent": import("potemkin/openapi").Schema<"Agent">');
      expect(sdk).toContain('readonly "SchemaEvent": import("potemkin/openapi").Schema<"Agent">');
      expect(sdk).toContain('OperationRequestBody<"createAgent">');
      expect(sdk).toContain('OperationResponses<"createAgent">');
      expect(sdk).toContain('readonly "Agent": import("potemkin/openapi").Schema<"Agent">');
      expect(sdk).toContain('readonly "id": string');
      expect(sdk).toContain('readonly "active": boolean');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('combines OpenAPI operation names with YAML event names in the schema', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-schema-'));
    try {
      const document = await loadOpenApi({
        openapi: '3.0.3',
        info: { title: 'Scenario', version: '1.0.0' },
        paths: {
          '/agents': {
            post: {
              operationId: 'createAgent',
              responses: { '201': { description: 'Created' } },
            },
          },
        },
      });
      const schema = await generatePotemkinYamlSchema({
        openapi: document,
        loaded: {
          yamlProgram: {
            modules: [
              {
                name: 'agent.yaml',
                yaml: [
                  'boundary: Agent',
                  'contract_path: /agents',
                  'event_catalog:',
                  '  - type: AgentCreated',
                  '    payload_template:',
                  "      id: '$uuidv7()'",
                  'behaviors:',
                  '  - name: create',
                  '    match:',
                  '      operationId: createAgent',
                  "      condition: 'true'",
                  '    emit: AgentCreated',
                ].join('\n'),
              },
            ],
          },
          boundaryModulePaths: [],
          componentModulePaths: [],
          useMappingModulePaths: [],
          globalModulePaths: [],
        } as never,
        outputDirectory: root,
      });
      const generated = await fs.readFile(schema.outputFile, 'utf8');
      expect(generated).toContain('createAgent');
      expect(generated).toContain('AgentCreated');
      expect(generated).toContain('payload_template');
      expect(generated).toContain('id');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('validates the complete nested YAML authoring surface', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-deep-schema-'));
    try {
      const document = await loadOpenApi({
        openapi: '3.0.3',
        info: { title: 'Deep schema', version: '1.0.0' },
        paths: { '/orders': { post: { operationId: 'createOrder', responses: {} } } },
      });
      const result = await generatePotemkinYamlSchema({
        openapi: document,
        loaded: {
          yamlProgram: { modules: [] },
          boundaryModulePaths: [],
          componentModulePaths: [],
          useMappingModulePaths: [],
          globalModulePaths: [],
        } as never,
        outputDirectory: root,
        scenario: {
          paths: ['/orders'],
          operationIds: ['createOrder'],
          schemas: [],
          eventTypes: ['OrderCreated'],
          eventSelectors: ['OrderCreated'],
          events: [{ boundary: 'Order', type: 'OrderCreated', fields: ['id'] }],
          components: [{ name: 'Shared', includes: [], uses: [] }],
          references: [],
          diagnostics: [],
          behaviors: [],
          reducers: [],
          queries: [],
          reactions: [],
          projections: [],
          sagas: [],
          webhooks: [],
          uses: [],
          projectFeatures: [],
          policies: { global: {} },
        },
      });
      const { $schema: _schema, ...validationSchema } = JSON.parse(
        await fs.readFile(result.outputFile, 'utf8'),
      ) as Record<string, unknown>;
      const validate = new Ajv({ allErrors: true, strict: false }).compile(validationSchema);
      const validYaml = {
        boundary: 'Order',
        contract_path: '/orders',
        event_catalog: [{ type: 'OrderCreated', payload_template: { id: '$uuidv7()' } }],
        behaviors: [
          {
            name: 'create',
            match: { operationId: 'createOrder', condition: 'true' },
            emit: 'OrderCreated',
            dispatch_commands: [
              {
                boundary: 'Order',
                intent: 'mutation',
                operationId: 'createOrder',
                target_id: 'command.targetId',
                payload: { id: 'event.payload.id' },
              },
            ],
          },
        ],
        reducers: [
          {
            on: 'OrderCreated',
            patches: [{ op: 'replace', path: '/id', value: 'event.payload.id' }],
          },
        ],
        state: {
          computed: [{ name: 'label', formula: 'state.id', depends_on: ['id'] }],
          internal: [{ name: 'audit', type: 'string' }],
        },
        identity: { key: { from: 'path', name: 'id' } },
        query: { sort: [{ field: 'id', direction: 'asc' }] },
        include: [{ component: 'Shared' }],
      };
      if (!validate(validYaml)) throw new Error(JSON.stringify(validate.errors));
      expect(
        validate({
          resource: 'order',
          schema: 'Order',
          event_catalog: [{ type: 'OrderCreated', payload_template: { id: 'command.targetId' } }],
          reducers: [{ on: 'OrderCreated', patches: [] }],
          operations: [{ op: 'createOrder', emit: 'OrderCreated' }],
        }),
      ).toBe(true);
      expect(
        validate({
          boundary: 'Order',
          contract_path: '/orders',
          reducers: [{ on: 'OrderCreated', patches: [{ op: 'replace', path: 'id' }] }],
        }),
      ).toBe(false);
      expect(
        validate({
          boundary: 'Order',
          contract_path: '/orders',
          include: ['Shared'],
        }),
      ).toBe(false);
      expect(
        validate({
          boundary: 'Order',
          contract_path: '/orders',
          event_catalog: [{ type: 'OrderCreated', schema_ref: 'Agent' }],
        }),
      ).toBe(false);
      expect(
        validate({
          boundary: 'Order',
          contract_path: '/orders',
          reducers: [{ on: 'OrderCreated', patches: [{ op: 'replace', path: '/id', by: 'two' }] }],
        }),
      ).toBe(false);
      expect(
        validate({
          fault_rules: [
            {
              name: 'unknown-operation',
              match: { operationId: 'missingOperation' },
              response: { status: 503 },
            },
          ],
        }),
      ).toBe(false);
      expect(
        validate({
          sagas: [
            {
              name: 'unknown-operation',
              trigger: { boundary: 'Order', intent: 'creation', condition: 'true' },
              steps: [
                {
                  name: 'step',
                  boundary: 'Order',
                  intent: 'mutation',
                  operationId: 'missingOperation',
                },
              ],
            },
          ],
        }),
      ).toBe(false);
      expect(
        validate({
          boundary: 'Order',
          contract_path: '/orders',
          identity: { key: { from: 'path', pointer: '/id' } },
        }),
      ).toBe(false);
      expect(
        validate({
          use: [
            { component: 'Shared', as: 'Order', contract_path: '/orders', with: { tenant: [] } },
          ],
        }),
      ).toBe(false);
      expect(
        validate({
          use: [{ component: 'Unknown', as: 'Order', contract_path: '/orders' }],
        }),
      ).toBe(false);
      expect(
        validate({
          kind: 'component',
          name: 'Shared',
          parameters: { tenant: { type: 'string', default: 'acme' } },
        }),
      ).toBe(true);
      expect(
        validate({
          kind: 'component',
          name: 'Shared',
          parameters: { tenant: { type: 'string', default: 42 } },
        }),
      ).toBe(false);
      expect(
        validate({
          kind: 'component',
          name: 'Shared',
          parameters: { tenant: { type: 'string', required: true, default: 'acme' } },
        }),
      ).toBe(false);
      expect(
        validate({
          webhooks: [
            {
              name: 'notify',
              trigger: { boundary: 'Order', condition: 'true' },
              url: 'https://example.test/hook',
              retry: { maxAttempts: 3, delayMs: 100 },
            },
          ],
        }),
      ).toBe(true);
      expect(
        validate({
          webhooks: [
            {
              name: 'notify',
              trigger: {},
              url: 'https://example.test/hook',
              retry: { max_attempts: 3 },
            },
          ],
        }),
      ).toBe(false);
      expect(
        validate({
          boundary: 'Order',
          contract_path: '/orders',
          deprecated: {},
        }),
      ).toBe(true);
      expect(
        validate({
          version: 1,
          specmatic: 'specmatic.yaml',
          modules: ['dsl/*.yaml'],
          typescript: { scan: [{ include: ['src/*.ts'] }], watchIntervalMs: 1000 },
          plugin: { controlPort: 8080 },
          governance: {
            report: { successCriteria: { minCoverage: 0.8 } },
            successCriterion: 'coverage',
          },
        }),
      ).toBe(true);
      expect(
        validate({
          version: 1,
          specmatic: 'specmatic.yaml',
          modules: ['dsl/*.yaml'],
          typescript: { scan: [{ include: ['src/*.ts'] }], watch_interval_ms: 1000 },
        }),
      ).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('augments the SDK event registry without shadowing the SDK module', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-sdk-bindings-'));
    try {
      const document = await loadOpenApi({
        openapi: '3.0.3',
        info: { title: 'SDK registry', version: '1.0.0' },
        paths: { '/agents': { post: { operationId: 'createAgent', responses: {} } } },
      });
      const result = await generateOpenApiBindings(document, {
        outputDirectory: root,
        scenario: {
          paths: [],
          operationIds: [],
          schemas: [],
          eventTypes: ['KnownEvent'],
          eventSelectors: ['KnownEvent'],
          events: [{ boundary: 'Agent', type: 'KnownEvent', fields: ['id'] }],
          references: [],
          diagnostics: [],
          behaviors: [],
          reducers: [],
          queries: [],
          reactions: [],
          projections: [],
          sagas: [],
          webhooks: [],
          uses: [],
          projectFeatures: [],
          policies: { global: {} },
        },
      });
      expect(await fs.readFile(result.sdkOutputFile, 'utf8')).toContain('readonly "createAgent"');
      const sourceFile = path.join(root, 'authoring.ts');
      const sdkStub = path.join(root, 'sdk-stub.ts');
      const openapiStub = path.join(root, 'openapi-stub.ts');
      await fs.writeFile(
        openapiStub,
        [
          'declare module "potemkin/openapi" {',
          '  export type Path = "/agents";',
          '  export type OperationRequestBody<Name extends "createAgent"> = { readonly id: string };',
          '  export type OperationResponses<Name extends "createAgent"> = { readonly 201: { readonly id: string } };',
          '}',
        ].join('\n'),
        'utf8',
      );
      await fs.writeFile(
        sdkStub,
        [
          'export interface ScenarioEventRegistry {}',
          'export interface ScenarioOperationRegistry {}',
          'export type ScenarioEventName = keyof ScenarioEventRegistry & string;',
          'export type ScenarioEventPayload<Name extends ScenarioEventName> = ScenarioEventRegistry[Name & keyof ScenarioEventRegistry];',
          'export type ScenarioOperationName = keyof ScenarioOperationRegistry & string;',
          'export type ScenarioOperation<Name extends ScenarioOperationName> = ScenarioOperationRegistry[Name & keyof ScenarioOperationRegistry];',
          'export type ScenarioOperationRequest<Name extends ScenarioOperationName> = ScenarioOperation<Name> extends { request: infer Request } ? Request : never;',
          'export type ScenarioOperationResponses<Name extends ScenarioOperationName> = ScenarioOperation<Name> extends { responses: infer Responses } ? Responses : never;',
          'type Accepted<Name extends string> = [keyof ScenarioEventRegistry] extends [never] ? Name : Name extends keyof ScenarioEventRegistry ? Name : never;',
          'type AcceptedOperation<Name extends string> = [keyof ScenarioOperationRegistry] extends [never] ? Name : Name extends keyof ScenarioOperationRegistry ? Name : never;',
          'export declare function eventType<const Name extends string>(value: Name & Accepted<Name>): Name;',
          'export declare function operationId<const Name extends string>(value: Name & AcceptedOperation<Name>): Name;',
          'export declare function boundaryName(value: string): string;',
        ].join('\n'),
        'utf8',
      );
      await fs.writeFile(
        sourceFile,
        [
          'import { eventType, operationId, boundaryName } from "potemkin/sdk";',
          'import type { ScenarioEventPayload, ScenarioOperationRequest, ScenarioOperationResponses } from "potemkin/sdk";',
          'const known = eventType("KnownEvent");',
          'const knownOperation = operationId("createAgent");',
          'const boundary = boundaryName("Agent");',
          'void known; void knownOperation; void boundary;',
          'const payload: ScenarioEventPayload<"KnownEvent"> = { id: "known" };',
          'const qualifiedPayload: ScenarioEventPayload<"Agent:KnownEvent"> = { id: "qualified" };',
          'const request: ScenarioOperationRequest<"createAgent"> = { id: "request" };',
          'const responses: ScenarioOperationResponses<"createAgent"> = { 201: { id: "response" } };',
          'void payload; void qualifiedPayload; void request; void responses;',
          '// @ts-expect-error generated request binding rejects the wrong payload type',
          'const invalidRequest: ScenarioOperationRequest<"createAgent"> = { id: 42 };',
          'void invalidRequest;',
          '// @ts-expect-error generated event registry rejects unknown names',
          'eventType("UnknownEvent");',
          '// @ts-expect-error generated operation registry rejects unknown names',
          'operationId("unknownOperation");',
        ].join('\n'),
        'utf8',
      );
      const program = ts.createProgram([sourceFile, result.sdkOutputFile, sdkStub], {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        baseUrl: process.cwd(),
        paths: { 'potemkin/sdk': [sdkStub], 'potemkin/openapi': [openapiStub] },
      });
      expect(ts.getPreEmitDiagnostics(program)).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('discovers TypeScript event declarations for the combined scenario', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-ts-events-'));
    try {
      await fs.writeFile(
        path.join(root, 'simulation.ts'),
        'event(eventType("TypeScriptCreated"), { id: "id" });',
        'utf8',
      );
      const document = await loadOpenApi({
        openapi: '3.0.3',
        info: { title: 'Scenario', version: '1.0.0' },
        paths: {},
      });
      const model = await collectScenarioModel(document, {
        potemkinConfigPath: path.join(root, 'potemkin.yml'),
        yamlProgram: { modules: [] },
        typescript: { scan: [{ include: ['simulation.ts'] }] },
      } as never);
      expect(model.eventTypes).toContain('TypeScriptCreated');
      expect(model.events.find((event) => event.type === 'TypeScriptCreated')?.fields).toEqual([
        'id',
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
