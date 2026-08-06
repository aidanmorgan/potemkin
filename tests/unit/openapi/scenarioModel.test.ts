import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadOpenApi } from '../../../src/contract/loader.js';
import {
  collectScenarioModel,
  ScenarioFieldType,
  ScenarioProjectFeatureName,
  ScenarioProjectFeatureOwner,
  ScenarioProjectFeatureSurface,
  ScenarioReferenceKind,
} from '../../../src/openapi/scenarioModel.js';

describe('source-neutral scenario descriptor', () => {
  it('exposes canonical finite vocabularies for editor and generator consumers', () => {
    expect(ScenarioReferenceKind.Boundary).toBe('boundary');
    expect(ScenarioFieldType.Unknown).toBe('unknown');
    expect(ScenarioProjectFeatureName.TypeScript).toBe('typescript');
    expect(ScenarioProjectFeatureOwner.PotemkinRuntime).toBe('potemkin-runtime');
    expect(ScenarioProjectFeatureSurface.LanguageServer).toBe('language-server');
  });

  it('retains validated authoring semantics and cross-language references', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-scenario-model-'));
    const boundaryPath = path.join(root, 'agent.yaml');
    const componentPath = path.join(root, 'shared.yaml');
    const usePath = path.join(root, 'use.yaml');
    try {
      const document = await loadOpenApi({
        openapi: '3.0.3',
        info: { title: 'Descriptor', version: '1.0.0' },
        paths: { '/agents': { post: { operationId: 'createAgent', responses: {} } } },
      });
      const boundary = `
boundary: Agent
contract_path: /agents
schema: Agent
identity:
  creation:
    generate: command.payload.id
initialization:
  - id: seed
query:
  fields:
    status: state.status
  sort:
    - { field: id, direction: asc }
event_catalog:
  - type: AgentCreated
    schema_ref: '#/components/schemas/Agent'
    payload_template: { id: command.payload.id }
behaviors:
  - name: create
    match:
      operationId: createAgent
      condition: 'true'
      requires:
        - { name: authorized, condition: 'true', error_code: FORBIDDEN, error_message: denied }
    emit: AgentCreated
    dispatch_commands:
      - { boundary: Audit, intent: creation, operationId: createAudit, target_id: command.payload.id, payload: { id: command.payload.id } }
reducers:
  - on: AgentCreated
    patches:
      - { op: replace, path: /id, value: '\${event.payload.id}' }
include:
  - component: Shared
`;
      const component = `
kind: component
name: Shared
parameters:
  tenant: { type: string, required: true }
event_catalog:
  - type: SharedEvent
    payload_template: { tenant: tenant }
`;
      const use = `use:
  - { component: Shared, as: SharedAgent, contract_path: /shared-agents, with: { tenant: acme } }
`;
      const model = await collectScenarioModel(document, {
        potemkinConfigPath: path.join(root, 'potemkin.yml'),
        configuration: {
          version: 1,
          specmatic: 'specmatic.yaml',
          modules: ['dsl/*.yaml'],
          seeds: [{ request: { method: 'POST', path: '/agents' }, base: 'empty', patches: [] }],
          workflow: { ids: { agentId: { extract: '$.id', use: '$.id' } } },
          overlay: { patches: [] },
          governance: { successCriterion: 'coverage' },
        },
        yamlProgram: {
          modules: [{ name: boundaryPath, yaml: boundary }],
          componentModules: [{ name: componentPath, yaml: component }],
          useMappingModules: [{ name: usePath, yaml: use }],
          globalYaml: 'idempotency: { enabled: true, ttl_seconds: 60, hash_includes_body: true }',
        },
      } as never);

      expect(model.boundaries?.[0]).toMatchObject({
        name: 'Agent',
        schema: 'Agent',
        initializationCount: 1,
        includes: ['Shared'],
      });
      expect(model.behaviors[0]).toMatchObject({
        boundary: 'Agent',
        operationId: 'createAgent',
        emissions: [{ event: 'AgentCreated' }],
        dispatches: [{ boundary: 'Audit', operationId: 'createAudit', payloadKeys: ['id'] }],
      });
      expect(model.reducers[0]?.patches).toEqual([{ op: 'replace', path: '/id' }]);
      expect(model.queries[0]?.fields).toEqual(['status']);
      expect(model.components?.[0]).toMatchObject({ name: 'Shared', parameters: ['tenant'] });
      expect(model.uses).toEqual([
        {
          component: 'Shared',
          as: 'SharedAgent',
          contractPath: '/shared-agents',
          with: { tenant: 'acme' },
        },
      ]);
      expect(model.events.find((event) => event.type === 'AgentCreated')).toMatchObject({
        boundary: 'Agent',
        schemaRef: '#/components/schemas/Agent',
        location: { sourcePath: boundaryPath },
      });
      expect(model.policies.global.idempotency?.ttlSeconds).toBe(60);
      expect(model.projectFeatures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'seeds',
            owner: 'specmatic-plugin',
            configured: true,
            surfaces: ['yaml-schema', 'language-server', 'plugin'],
          }),
          expect.objectContaining({
            name: 'modules',
            owner: 'potemkin-runtime',
            configured: true,
          }),
        ]),
      );
      expect(model.references).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'event', name: 'AgentCreated' }),
          expect.objectContaining({ kind: 'component', name: 'Shared' }),
          expect.objectContaining({ kind: 'schema', name: 'Agent' }),
        ]),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps diagnostics and source paths when an unsaved module is invalid', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-scenario-diagnostic-'));
    const boundaryPath = path.join(root, 'agent.yaml');
    try {
      const document = await loadOpenApi({
        openapi: '3.0.3',
        info: { title: 'Descriptor', version: '1.0.0' },
        paths: {},
      });
      const model = await collectScenarioModel(
        document,
        {
          potemkinConfigPath: path.join(root, 'potemkin.yml'),
          configuration: { version: 1, specmatic: 'specmatic.yaml', modules: ['dsl/*.yaml'] },
          yamlProgram: { modules: [{ name: boundaryPath, yaml: 'boundary: Agent\n' }] },
        } as never,
        { documents: new Map([[boundaryPath, 'boundary: Agent\nbehaviors: [']]) },
      );

      expect(model.boundaries).toEqual([]);
      expect(model.diagnostics).toEqual([
        expect.objectContaining({ severity: 'error', location: { sourcePath: boundaryPath } }),
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('assigns statically composed TypeScript events to their boundary identity', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-scenario-typescript-'));
    const sourcePath = path.join(root, 'authoring.ts');
    try {
      await fs.writeFile(
        sourcePath,
        [
          'const created = event(eventType("Created"), { id: "value" });',
          'const shared = defineComponent(componentName("Shared"), { eventCatalog: [created] });',
          'const resource = defineResource(resourceName("Agent"), { schema: schemaReference("Agent"), operations: [{ operationId: operationId("createAgent") }] });',
          'const contract = boundary(boundaryName("Agent"), contractPath(pathSegment("/agents")))',
          '  .eventCatalog(created);',
        ].join('\n'),
        'utf8',
      );
      const document = await loadOpenApi({
        openapi: '3.0.3',
        info: { title: 'Descriptor', version: '1.0.0' },
        paths: { '/agents': { post: { operationId: 'createAgent', responses: {} } } },
      });
      const model = await collectScenarioModel(document, {
        potemkinConfigPath: path.join(root, 'potemkin.yml'),
        configuration: { version: 1, specmatic: 'specmatic.yaml', modules: [] },
        typescript: { scan: [{ include: [sourcePath] }] },
        yamlProgram: { modules: [] },
      } as never);

      expect(model.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ boundary: 'Agent', type: 'Created', fields: ['id'] }),
        ]),
      );
      expect(model.components).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'Shared', sourcePath })]),
      );
      expect(model.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'Agent',
            schema: 'Agent',
            operationIds: ['createAgent'],
          }),
        ]),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
