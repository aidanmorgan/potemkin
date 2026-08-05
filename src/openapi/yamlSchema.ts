import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Eta } from 'eta';

import type { OpenApiDoc } from '../contract/loader.js';
import type { LoadedConfig } from '../parser/configLoader.js';
import {
  collectScenarioModel,
  type ScenarioEventModel,
  type ScenarioModel,
} from './scenarioModel.js';

export interface GeneratedPotemkinYamlSchema {
  readonly outputFile: string;
  readonly changed: boolean;
}

export interface PotemkinYamlSchemaOptions {
  readonly openapi: OpenApiDoc;
  readonly loaded: LoadedConfig;
  readonly outputDirectory: string;
  readonly moduleName?: string;
  readonly scenario?: ScenarioModel;
}

type JsonSchema = Record<string, unknown>;

/** Build a JSON Schema conditional without triggering promise-like object linting. */
function conditionalSchema(ifSchema: JsonSchema, thenSchema: JsonSchema): JsonSchema {
  const schema: JsonSchema = { if: ifSchema };
  // oxlint-disable-next-line unicorn/no-thenable -- `then` is a JSON Schema keyword here.
  schema['then'] = thenSchema;
  return schema;
}

const TEMPLATE_FILE = path.join(__dirname, 'templates', 'potemkin.schema.json.eta');

/**
 * Build the YAML authoring schema from both sides of a scenario:
 * OpenAPI supplies paths, operationIds, and component names; Potemkin YAML
 * supplies boundary-scoped event names and payload-template fields.
 */
export async function generatePotemkinYamlSchema(
  options: PotemkinYamlSchemaOptions,
): Promise<GeneratedPotemkinYamlSchema> {
  const model = options.scenario ?? (await collectScenarioModel(options.openapi, options.loaded));
  const schema = buildSchema(model);
  const template = await fs.readFile(TEMPLATE_FILE, 'utf8');
  const content = new Eta().renderString(template, {
    schema,
    json: (value: unknown) => JSON.stringify(value, null, 2),
  });
  const outputFile = path.join(path.resolve(options.outputDirectory), 'potemkin.schema.json');
  let previous: string | undefined;
  try {
    previous = await fs.readFile(outputFile, 'utf8');
  } catch {
    // First generation.
  }
  if (previous === content) return { outputFile, changed: false };
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  const temporaryFile = `${outputFile}.${process.pid}.tmp`;
  await fs.writeFile(temporaryFile, content, 'utf8');
  await fs.rename(temporaryFile, outputFile);
  return { outputFile, changed: true };
}

function buildSchema(model: ScenarioModel): JsonSchema {
  const operationId = stringOrEnum(model.operationIds);
  const contractPath = stringOrEnum(model.paths);
  const eventType = stringOrEnum(model.eventTypes);
  const eventSelector = stringOrEnum(model.eventSelectors);
  const schemaName = stringOrEnum(model.schemas);
  const componentName = stringOrEnum(model.components?.map((component) => component.name) ?? []);
  const resourceName = stringOrEnum(model.resources?.map((resource) => resource.name) ?? []);
  const boundaryVariants = model.events.some((event) => event.boundary !== '')
    ? boundarySchemas(model, operationId, contractPath, eventSelector)
    : [];
  const boundary =
    boundaryVariants.length === 0
      ? boundarySchema(operationId, contractPath, eventType, eventSelector, schemaName, {
          componentName,
        })
      : { oneOf: boundaryVariants };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://potemkin.dev/schemas/potemkin-scenario.json',
    title: 'Potemkin scenario YAML',
    description: 'Combined OpenAPI and Potemkin authoring schema. Generated; do not edit.',
    $defs: { jsonValue: jsonValueDefinition() },
    oneOf: [
      configSchema(),
      boundary,
      componentSchema(operationId, eventType, schemaName, componentName),
      resourceSchema(resourceName, operationId, eventType, schemaName),
      useMappingSchema(componentName, contractPath),
      globalSchema(eventSelector, eventType, operationId),
    ],
  };
}

function boundarySchemas(
  model: ScenarioModel,
  operationId: JsonSchema,
  contractPath: JsonSchema,
  eventSelector: JsonSchema,
): readonly JsonSchema[] {
  const byBoundary = new Map<string, ScenarioEventModel[]>();
  for (const event of model.events) {
    if (event.boundary === '') continue;
    const entries = byBoundary.get(event.boundary) ?? [];
    entries.push(event);
    byBoundary.set(event.boundary, entries);
  }
  return [...byBoundary.entries()].map(([boundaryName, events]) => {
    const eventTypes = stringOrEnum(events.map((event) => event.type));
    const fields = stringOrEnum(events.flatMap((event) => event.fields));
    return boundarySchema(
      operationId,
      contractPath,
      eventTypes,
      eventSelector,
      stringOrEnum(model.schemas),
      {
        boundaryName,
        payloadFields: fields,
        componentName: stringOrEnum(model.components?.map((component) => component.name) ?? []),
      },
    );
  });
}

function boundarySchema(
  operationId: JsonSchema,
  contractPath: JsonSchema,
  eventType: JsonSchema,
  eventSelector: JsonSchema,
  schemaName: JsonSchema,
  dynamic: {
    readonly boundaryName?: string;
    readonly payloadFields?: JsonSchema;
    readonly componentName?: JsonSchema;
  } = {},
): JsonSchema {
  const eventCatalog: JsonSchema = {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      properties: {
        type: eventType,
        payload_template: {
          type: 'object',
          propertyNames: dynamic.payloadFields ?? { type: 'string' },
          additionalProperties: { type: 'string' },
        },
        schema_ref: schemaReferenceSchema(schemaName),
      },
    },
  };
  const behaviors = {
    type: 'array',
    items: behaviorSchema(operationId, eventType),
  };
  const reducers = {
    type: 'array',
    items: reducerSchema(eventType),
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['boundary', 'contract_path'],
    properties: {
      boundary:
        dynamic.boundaryName === undefined ? { type: 'string' } : { const: dynamic.boundaryName },
      contract_path: contractPath,
      schema: schemaName,
      fallback_override: { type: 'boolean' },
      identity: identitySchema(),
      query: querySchema(),
      query_mapping: stringMapSchema(),
      event_catalog: eventCatalog,
      behaviors,
      reducers,
      initialization: initializationSchema(),
      deprecated: deprecationSchema(),
      hateoas: hateoasSchema(),
      mask: { type: 'array', items: { type: 'string' } },
      state: stateSchema(),
      strict_schema: { type: 'boolean' },
      latency: latencySchema(),
      audit_fields: { type: 'boolean' },
      fault_rules: { type: 'array', items: faultRuleSchema(operationId) },
      reactions: { type: 'array', items: reactionSchema(eventSelector, eventType) },
      response: { type: 'string' },
      include: { type: 'array', items: includeSchema(dynamic.componentName) },
      export: exportSchema(),
      spec_id: { type: 'string' },
      out_of_contract: { type: 'boolean' },
      methods: { type: 'array', items: { type: 'string' } },
    },
  };
}

function configSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['version', 'specmatic', 'modules'],
    properties: {
      version: { type: 'integer', minimum: 1 },
      specmatic: { type: 'string' },
      modules: { type: 'array', minItems: 1, items: { type: 'string' } },
      openapi: { type: 'array', minItems: 1, items: { type: 'string' } },
      typescript: {
        type: 'object',
        additionalProperties: false,
        required: ['scan'],
        properties: {
          scan: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['include'],
              properties: {
                include: { type: 'array', minItems: 1, items: { type: 'string' } },
                exclude: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          watchIntervalMs: { type: 'number', exclusiveMinimum: 0 },
        },
      },
      plugin: pluginSchema(),
      seeds: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['request', 'base'],
          properties: {
            description: { type: 'string' },
            request: {
              type: 'object',
              additionalProperties: false,
              required: ['method', 'path'],
              properties: { method: { type: 'string' }, path: { type: 'string' } },
            },
            base: { enum: ['contract', 'empty'] },
            patches: { type: 'array', items: patchSchema() },
          },
        },
      },
      workflow: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ids: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              additionalProperties: false,
              required: ['extract', 'use'],
              properties: { extract: { type: 'string' }, use: { type: 'string' } },
            },
          },
        },
      },
      overlay: {
        type: 'object',
        additionalProperties: false,
        required: ['patches'],
        properties: { patches: { type: 'array', items: patchSchema() } },
      },
      governance: {
        type: 'object',
        additionalProperties: false,
        properties: {
          report: {
            type: 'object',
            additionalProperties: false,
            properties: {
              format: { type: 'string' },
              successCriteria: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  minCoverage: { type: 'number' },
                  excludedEndpoints: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
          successCriterion: { type: 'string' },
        },
      },
    },
  };
}

function componentSchema(
  operationId: JsonSchema,
  eventType: JsonSchema,
  schemaName: JsonSchema,
  componentName: JsonSchema,
): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'name'],
    properties: {
      kind: { const: 'component' },
      name: { type: 'string' },
      parameters: {
        type: 'object',
        additionalProperties: parameterDeclarationSchema(),
      },
      event_catalog: { type: 'array', items: eventSchema(eventType, schemaName) },
      reducers: { type: 'array', items: reducerSchema(eventType) },
      behaviors: { type: 'array', items: behaviorSchema(operationId, eventType) },
      schema: schemaName,
      fallback_override: { type: 'boolean' },
      identity: identitySchema(),
      query: querySchema(),
      query_mapping: stringMapSchema(),
      state: stateSchema(),
      deprecated: deprecationSchema(),
      hateoas: hateoasSchema(),
      mask: { type: 'array', items: { type: 'string' } },
      latency: latencySchema(),
      audit_fields: { type: 'boolean' },
      strict_schema: { type: 'boolean' },
      fault_rules: { type: 'array', items: faultRuleSchema(operationId) },
      reactions: { type: 'array', items: reactionSchema({ type: 'string' }, eventType) },
      include: { type: 'array', items: includeSchema(componentName) },
      response: { type: 'string' },
    },
  };
}

function resourceSchema(
  resourceName: JsonSchema,
  operationId: JsonSchema,
  eventType: JsonSchema,
  schemaName: JsonSchema,
): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['resource', 'schema', 'event_catalog', 'reducers', 'operations'],
    properties: {
      resource: resourceName,
      schema: schemaName,
      identity: identitySchema(),
      response: { type: 'string' },
      query: querySchema(),
      query_mapping: stringMapSchema(),
      event_catalog: { type: 'array', items: eventSchema(eventType, schemaName) },
      reducers: { type: 'array', items: reducerSchema(eventType) },
      reactions: { type: 'array', items: reactionSchema({ type: 'string' }, eventType) },
      initialization: initializationSchema(),
      mask: { type: 'array', items: { type: 'string' } },
      hateoas: hateoasSchema(),
      state: stateSchema(),
      deprecated: deprecationSchema(),
      latency: latencySchema(),
      strict_schema: { type: 'boolean' },
      audit_fields: { type: 'boolean' },
      fault_rules: { type: 'array', items: faultRuleSchema(operationId) },
      operations: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['op'],
          properties: {
            op: operationId,
            emit: eventType,
            query: { type: 'boolean' },
            condition: { type: 'string' },
            requires: { type: 'array', items: requiresSchema() },
            emit_when: { type: 'array', items: emitWhenSchema(eventType) },
            dispatch_commands: { type: 'array', items: dispatchCommandSchema(operationId) },
          },
          anyOf: [
            { required: ['emit'], properties: { query: { not: { const: true } } } },
            {
              required: ['query'],
              properties: { query: { const: true } },
              not: { required: ['emit'] },
            },
          ],
        },
      },
    },
  };
}

function useMappingSchema(componentName: JsonSchema, contractPath: JsonSchema): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['use'],
    properties: {
      use: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['component', 'as', 'contract_path'],
          properties: {
            component: componentName,
            as: { type: 'string', minLength: 1 },
            contract_path: contractPath,
            with: parameterBindingsSchema(),
            bind: stringMapSchema(),
          },
        },
      },
    },
  };
}

function globalSchema(
  eventSelector: JsonSchema,
  eventType: JsonSchema,
  operationId: JsonSchema,
): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      sagas: { type: 'array', items: sagaSchema(operationId) },
      idempotency: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean' },
          ttl_seconds: { type: 'integer', minimum: 0 },
          hash_includes_body: { type: 'boolean' },
        },
      },
      derived_projections: { type: 'array', items: projectionSchema(eventSelector, eventType) },
      auth: authSchema(),
      security_headers: securityHeadersSchema(),
      versioning: versioningSchema(),
      hateoas: hateoasConfigSchema(),
      webhooks: { type: 'array', items: webhookSchema() },
      fault_rules: { type: 'array', items: faultRuleSchema(operationId) },
      reactions: { type: 'array', items: reactionSchema(eventSelector, eventType) },
      fallback: fallbackSchema(),
      coverage: { type: 'object', additionalProperties: coverageSchema() },
    },
  };
}

function behaviorSchema(operationId: JsonSchema, eventType: JsonSchema): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'match'],
    properties: {
      name: { type: 'string' },
      match: {
        type: 'object',
        additionalProperties: false,
        required: ['operationId', 'condition'],
        properties: {
          operationId,
          condition: { type: 'string' },
          requires: { type: 'array', items: requiresSchema() },
          required_scopes: { type: 'array', items: { type: 'string' } },
          method: { type: 'string' },
          headers: stringMapSchema(),
        },
      },
      emit: eventType,
      emit_when: { type: 'array', minItems: 1, items: emitWhenSchema(eventType) },
      dispatch_commands: { type: 'array', items: dispatchCommandSchema(operationId) },
      postcondition: { type: 'string' },
      link_name: { type: 'string' },
      link_condition: { type: 'string' },
      response_status: { type: 'integer', minimum: 100, maximum: 599 },
    },
  };
}

function reducerSchema(eventType: JsonSchema): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['on'],
    properties: {
      on: eventType,
      replace_state: { type: 'boolean' },
      patches: { type: 'array', items: patchSchema() },
    },
  };
}

function reactionSchema(eventSelector: JsonSchema, eventType: JsonSchema): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['on', 'emit'],
    properties: {
      name: { type: 'string' },
      on: eventSelector,
      when: { type: 'string' },
      boundary: { type: 'string' },
      emit: eventType,
      intent: { enum: ['mutation', 'creation'] },
      target: { type: 'string' },
      payload: stringMapSchema(),
    },
  };
}

function initializationSchema(): JsonSchema {
  return {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: jsonValueReference(),
      description: 'Initial aggregate state objects, optionally carrying id and event metadata.',
    },
  };
}

function deprecationSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      date: { type: 'string' },
      sunset: { type: 'string' },
      replacement: { type: 'string', minLength: 1 },
    },
  };
}

function hateoasSchema(): JsonSchema {
  return {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['rel', 'href'],
      properties: { rel: { type: 'string', minLength: 1 }, href: { type: 'string', minLength: 1 } },
    },
  };
}

function stateSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      computed: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'formula'],
          properties: {
            name: { type: 'string' },
            formula: { type: 'string' },
            depends_on: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      internal: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'type'],
          properties: {
            name: { type: 'string' },
            type: fieldTypeSchema(),
          },
        },
      },
    },
  };
}

function latencySchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      min_ms: { type: 'number', minimum: 0 },
      max_ms: { type: 'number', minimum: 0 },
      fixed_ms: { type: 'number', minimum: 0 },
    },
  };
}

function emitWhenSchema(eventType: JsonSchema): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['when', 'emit'],
    properties: { when: { type: 'string', minLength: 1 }, emit: eventType },
  };
}

function dispatchCommandSchema(operationId: JsonSchema = { type: 'string' }): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['boundary', 'intent', 'operationId'],
    properties: {
      boundary: { type: 'string', minLength: 1 },
      intent: { enum: ['creation', 'mutation', 'query'] },
      operationId,
      target_id: { type: 'string', minLength: 1 },
      payload: { type: 'object', additionalProperties: { type: 'string' } },
      condition: { type: 'string' },
    },
  };
}

function faultRuleSchema(operationId: JsonSchema = { type: 'string' }): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'match', 'response'],
    properties: {
      name: { type: 'string', minLength: 1 },
      match: {
        type: 'object',
        additionalProperties: false,
        properties: {
          boundary: { type: 'string' },
          intent: { enum: ['creation', 'mutation', 'query'] },
          operationId,
          method: { type: 'string' },
          condition: { type: 'string' },
          requires: { type: 'array', items: requiresSchema() },
          headers: stringMapSchema(),
          required_scopes: { type: 'array', items: { type: 'string' } },
          probability: { type: 'number', minimum: 0, maximum: 1 },
          potemkin: stringMapSchema(),
        },
      },
      response: {
        type: 'object',
        additionalProperties: false,
        required: ['status'],
        properties: {
          status: { type: 'integer', minimum: 100, maximum: 599 },
          body: jsonValueReference(),
          headers: stringMapSchema(),
          delay_ms: { type: 'number', minimum: 0 },
        },
      },
      delay_ms: { type: 'number', minimum: 0 },
    },
  };
}

function sagaSchema(operationId: JsonSchema = { type: 'string' }): JsonSchema {
  const step = {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'boundary', 'intent', 'operationId'],
    properties: {
      name: { type: 'string' },
      boundary: { type: 'string' },
      intent: { enum: ['creation', 'mutation', 'query'] },
      operationId,
      target_id: { type: 'string' },
      payload: stringMapSchema(),
      compensation: {
        type: 'object',
        additionalProperties: false,
        required: ['intent', 'operationId'],
        properties: {
          intent: { enum: ['creation', 'mutation', 'query'] },
          operationId,
          target_id: { type: 'string' },
          payload: stringMapSchema(),
        },
      },
    },
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'trigger', 'steps'],
    properties: {
      name: { type: 'string' },
      trigger: {
        type: 'object',
        additionalProperties: false,
        required: ['boundary', 'intent', 'condition'],
        properties: {
          boundary: { type: 'string' },
          intent: { enum: ['creation', 'mutation', 'query'] },
          condition: { type: 'string' },
        },
      },
      steps: { type: 'array', minItems: 1, items: step },
    },
  };
}

function projectionSchema(eventSelector: JsonSchema, eventType: JsonSchema): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'key', 'subscribe', 'reduce'],
    properties: {
      name: { type: 'string' },
      key: { type: 'string' },
      subscribe: { type: 'array', minItems: 1, items: eventSelector },
      reduce: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['on'],
          properties: { on: eventType, patches: { type: 'array', items: patchSchema() } },
        },
      },
    },
  };
}

function webhookSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'trigger', 'url'],
    properties: {
      name: { type: 'string' },
      trigger: {
        type: 'object',
        additionalProperties: false,
        properties: {
          boundary: { type: 'string' },
          intent: { enum: ['creation', 'mutation', 'query'] },
          condition: { type: 'string' },
        },
      },
      url: { type: 'string' },
      secret: { type: 'string' },
      payload: stringMapSchema(),
      retry: {
        type: 'object',
        additionalProperties: false,
        properties: { maxAttempts: { type: 'number' }, delayMs: { type: 'number' } },
      },
    },
  };
}

function identitySchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      creation: {
        type: 'object',
        additionalProperties: false,
        properties: { generate: { type: 'string' } },
      },
      key: {
        type: 'object',
        additionalProperties: false,
        required: ['from'],
        properties: {
          from: { enum: ['path', 'query', 'header', 'payload'] },
          name: { type: 'string' },
          pointer: { type: 'string' },
        },
        allOf: [
          conditionalSchema(
            { properties: { from: { enum: ['path', 'query', 'header'] } } },
            { required: ['name'] },
          ),
          conditionalSchema(
            { properties: { from: { const: 'payload' } } },
            { anyOf: [{ required: ['name'] }, { required: ['pointer'] }] },
          ),
        ],
      },
    },
  };
}

function querySchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      fields: stringMapSchema(),
      filter: { type: 'string' },
      sort: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['field'],
          properties: { field: { type: 'string' }, direction: { enum: ['asc', 'desc'] } },
        },
      },
      page_size: { oneOf: [{ type: 'string' }, { type: 'number', minimum: 0 }] },
      max_page_size: { type: 'integer', minimum: 0 },
      cursor: { type: 'string' },
      expand: { type: 'array', items: { type: 'string' } },
      pagination: { enum: ['raw', 'envelope'] },
      include_deleted: { type: 'boolean' },
      fallback: jsonValueReference(),
    },
  };
}

function stringMapSchema(): JsonSchema {
  return { type: 'object', additionalProperties: { type: 'string' } };
}

function eventSchema(eventType: JsonSchema, schemaName?: JsonSchema): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['type'],
    properties: {
      type: eventType,
      payload_template: { type: 'object', additionalProperties: { type: 'string' } },
      schema_ref: schemaReferenceSchema(schemaName),
    },
  };
}

function schemaReferenceSchema(schemaName: JsonSchema | undefined): JsonSchema {
  const names = schemaName?.enum;
  return Array.isArray(names) && names.length > 0
    ? { type: 'string', enum: names.map((name) => `#/components/schemas/${name}`) }
    : { type: 'string', pattern: '^#/components/schemas/[A-Za-z0-9._-]+$' };
}

function includeSchema(componentName?: JsonSchema): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['component'],
    properties: {
      component: componentName ?? { type: 'string', minLength: 1 },
      with: parameterBindingsSchema(),
    },
  };
}

function parameterDeclarationSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['type'],
    properties: {
      type: { enum: ['string', 'number', 'boolean'] },
      default: { type: ['string', 'number', 'boolean'] },
      required: { type: 'boolean' },
    },
    allOf: [
      conditionalSchema(
        { properties: { type: { const: 'string' } } },
        { properties: { default: { type: 'string' } } },
      ),
      conditionalSchema(
        { properties: { type: { const: 'number' } } },
        { properties: { default: { type: 'number' } } },
      ),
      conditionalSchema(
        { properties: { type: { const: 'boolean' } } },
        { properties: { default: { type: 'boolean' } } },
      ),
      conditionalSchema(
        { required: ['required'], properties: { required: { const: true } } },
        { not: { required: ['default'] } },
      ),
    ],
  };
}

function requiresSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'condition', 'error_code', 'error_message'],
    properties: {
      name: { type: 'string' },
      condition: { type: 'string' },
      error_code: { type: 'string' },
      error_message: { type: 'string' },
      error_status: { type: 'integer', minimum: 100, maximum: 599 },
    },
  };
}

function patchSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['op', 'path'],
    properties: {
      op: {
        enum: [
          'add',
          'remove',
          'replace',
          'append',
          'prepend',
          'increment',
          'merge',
          'upsert',
          'move',
          'copy',
        ],
      },
      path: { type: 'string', pattern: '^/' },
      from: { type: 'string', pattern: '^/' },
      value: jsonValueReference(),
      by: { type: 'number' },
      key: { type: 'string' },
      deep: { type: 'boolean' },
    },
  };
}

function parameterBindingsSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: { type: ['string', 'number', 'boolean'] },
  };
}

function jsonValueReference(): JsonSchema {
  return { $ref: '#/$defs/jsonValue' };
}

function jsonValueDefinition(): JsonSchema {
  return {
    oneOf: [
      { type: 'string' },
      { type: 'number' },
      { type: 'boolean' },
      { type: 'null' },
      { type: 'array', items: jsonValueReference() },
      { type: 'object', additionalProperties: jsonValueReference() },
    ],
  };
}

function authSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      mode: { enum: ['simple', 'jwt', 'session'] },
      jwt: {
        type: 'object',
        additionalProperties: false,
        required: ['secret'],
        properties: {
          secret: { type: 'string' },
          algorithm: { const: 'HS256' },
          issuer: { type: 'string' },
          audience: { type: 'string' },
          required_claims: stringMapSchema(),
          subject_claim: { type: 'string' },
          scopes_claim: { type: 'string' },
        },
      },
      session: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cookie_name: { type: 'string' },
          ttl_seconds: { type: 'integer', minimum: 0 },
          csrf: { type: 'boolean' },
          csrf_header: { type: 'string' },
          login_path: { type: 'string' },
          logout_path: { type: 'string' },
        },
      },
    },
  };
}

function securityHeadersSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      enabled: { type: 'boolean' },
      hsts: { type: 'boolean' },
      nosniff: { type: 'boolean' },
      frame_deny: { type: 'boolean' },
      referrer_policy: { type: 'string' },
      custom_headers: stringMapSchema(),
    },
  };
}

function versioningSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      enabled: { type: 'boolean' },
      versions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['version', 'prefix'],
          properties: {
            version: { type: 'string' },
            prefix: { type: 'string' },
            default: { type: 'boolean' },
          },
        },
      },
    },
  };
}

function hateoasConfigSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      enabled: { type: 'boolean' },
      base_url: { type: 'string' },
      self_links: { type: 'boolean' },
    },
  };
}

function fallbackSchema(): JsonSchema {
  const response = {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'integer', minimum: 100, maximum: 599 },
      body: jsonValueReference(),
    },
  };
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      rules: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['match', 'respond'],
          properties: {
            match: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string' },
                method: { type: 'string' },
                in_contract: { type: 'boolean' },
              },
            },
            respond: response,
          },
        },
      },
      default: response,
    },
  };
}

function coverageSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      strict: { type: 'boolean' },
      initial_states: { type: 'array', items: { type: 'string' } },
      terminal_states: { type: 'array', items: { type: 'string' } },
      operations: { type: 'array', items: { type: 'string' } },
      suppress_states: { type: 'array', items: { type: 'string' } },
    },
  };
}

function pluginSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      engine: {
        type: 'object',
        additionalProperties: false,
        properties: { url: { type: 'string' }, timeoutMs: { type: 'number', exclusiveMinimum: 0 } },
      },
      controlPort: { type: 'integer', minimum: 0, maximum: 65535 },
      resilience: {
        type: 'object',
        additionalProperties: false,
        properties: {
          maxRetries: { type: 'number', minimum: 0 },
          backoffMs: { type: 'number', minimum: 0 },
        },
      },
      healthProbe: {
        type: 'object',
        additionalProperties: false,
        properties: {
          initialMs: { type: 'number', minimum: 0 },
          stableMs: { type: 'number', minimum: 0 },
          path: { type: 'string' },
        },
      },
      discovery: {
        type: 'object',
        additionalProperties: false,
        properties: {
          refreshOnFailureMs: { type: 'number', minimum: 0 },
          ttlSeconds: { type: 'number', minimum: 0 },
        },
      },
      circuitBreaker: {
        type: 'object',
        additionalProperties: false,
        properties: {
          failureRate: { type: 'number', minimum: 0, maximum: 1 },
          waitMs: { type: 'number', minimum: 0 },
        },
      },
      auth: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { enum: ['none', 'jwt'] },
          algorithm: { enum: ['HS256', 'RS256'] },
          secret: { type: 'string' },
          jwks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kty', 'n', 'e'],
              properties: {
                kty: { type: 'string' },
                kid: { type: 'string' },
                n: { type: 'string' },
                e: { type: 'string' },
              },
            },
          },
          jwksUrl: { type: 'string' },
          realm: { type: 'string' },
        },
      },
    },
  };
}

function exportSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['states'],
    properties: {
      states: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'steps'],
          properties: {
            name: { type: 'string' },
            saga: { type: 'string' },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['operationId'],
                properties: {
                  operationId: { type: 'string' },
                  body: jsonValueReference(),
                  headers: stringMapSchema(),
                },
              },
            },
          },
        },
      },
    },
  };
}

function fieldTypeSchema(): JsonSchema {
  return { enum: ['string', 'integer', 'number', 'boolean', 'null', 'array', 'object'] };
}

function stringOrEnum(values: readonly string[]): JsonSchema {
  return values.length === 0 ? { type: 'string' } : { type: 'string', enum: [...new Set(values)] };
}
