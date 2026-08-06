import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { parse } from 'yaml';
import { glob } from 'tinyglobby';

import type { OpenApiDoc } from '../contract/loader.js';
import type { LoadedConfig } from '../parser/configLoader.js';
import type { JsonObject } from '../contracts/value.js';
import { parseComponent, parseUseMapping, parseYaml } from '../parser/yamlParser.js';
import { validateGlobalConfig } from '../dsl/schema.js';
import type {
  BehaviorRule,
  BoundaryConfig,
  ComponentDefinition,
  DerivedProjectionConfig,
  ReactionRule,
  ReducerRule,
  SagaConfig,
  WebhookConfig,
} from '../dsl/types.js';
import type { GlobalConfig } from '../dsl/schema.js';
import {
  extractTypeScriptDefinitions,
  extractTypeScriptEvents,
} from './typescriptScenarioModel.js';
import type {
  JsonSchemaReference,
  ScenarioBehaviorModel,
  ScenarioBoundaryModel,
  ScenarioComponentModel,
  ScenarioDiagnostic,
  ScenarioEventModel,
  ScenarioModel,
  ScenarioOperationModel,
  ScenarioProjectFeature,
  ScenarioProjectionModel,
  ScenarioQueryModel,
  ScenarioReactionModel,
  ScenarioReducerModel,
  ScenarioReference,
  ScenarioReferenceKind,
  ScenarioResourceModel,
  ScenarioSagaModel,
  ScenarioSourceLocation,
  ScenarioSourceOverrides,
  ScenarioWebhookModel,
} from './scenarioModel.js';
import { httpMethods, type HttpMethod } from '../domain/references.js';

const HTTP_METHOD_VALUES: ReadonlySet<string> = new Set(httpMethods);

/** Build the shared contract-plus-authoring graph used by both IDE generators. */
export async function collectScenarioModel(
  openapi: OpenApiDoc,
  loaded: LoadedConfig,
  overrides: ScenarioSourceOverrides = {},
): Promise<ScenarioModel> {
  const operationIds = new Set<string>();
  const operations: ScenarioOperationModel[] = [];
  for (const [route, item] of Object.entries(openapi.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      const normalizedMethod = method.toUpperCase();
      if (operation?.operationId !== undefined && isHttpMethod(normalizedMethod)) {
        operationIds.add(operation.operationId);
        operations.push({
          operationId: operation.operationId,
          path: route,
          method: normalizedMethod,
          parameters: operation.parameters?.map((parameter) => parameter.name) ?? [],
          ...(operation.requestBodySchema === undefined
            ? {}
            : { requestSchema: schemaReference(operation.requestBodySchema) }),
          responseSchemas: Object.fromEntries(
            Object.entries(operation.responseSchemas ?? {}).map(([status, schema]) => [
              status,
              schemaReference(schema),
            ]),
          ),
        });
      }
    }
  }
  const raw = asRecord(openapi.source ?? openapi.raw);
  const openapiComponents = asRecord(raw['components']);
  const schemas = Object.keys(asRecord(openapiComponents['schemas']));
  const diagnostics: ScenarioDiagnostic[] = [];
  const fallbackEvents: ScenarioEventModel[] = [];
  const fallbackBehaviors: ScenarioBehaviorModel[] = [];
  const fallbackReducers: ScenarioReducerModel[] = [];
  const boundaryConfigs: readonly {
    readonly config: BoundaryConfig;
    readonly sourcePath: string;
  }[] = loaded.yamlProgram.modules.flatMap((module) => {
    const sourcePath = path.resolve(module.name);
    const text = overrides.documents?.get(sourcePath) ?? module.yaml;
    try {
      return [{ config: parseYaml(text), sourcePath }];
    } catch (error) {
      diagnostics.push(parseDiagnostic(error, sourcePath));
      const partial = unvalidatedYamlSymbols(text, sourcePath);
      fallbackEvents.push(...partial.events);
      fallbackBehaviors.push(...partial.behaviors);
      fallbackReducers.push(...partial.reducers);
      return [];
    }
  });
  const componentConfigs: readonly {
    readonly config: ComponentDefinition;
    readonly sourcePath: string;
  }[] = (loaded.yamlProgram.componentModules ?? []).flatMap((module) => {
    const sourcePath = path.resolve(module.name);
    const text = overrides.documents?.get(sourcePath) ?? module.yaml;
    try {
      return [{ config: parseComponent(text), sourcePath }];
    } catch (error) {
      diagnostics.push(parseDiagnostic(error, sourcePath));
      return [];
    }
  });
  const uses = (loaded.yamlProgram.useMappingModules ?? []).flatMap((module) => {
    const sourcePath = path.resolve(module.name);
    const text = overrides.documents?.get(sourcePath) ?? module.yaml;
    try {
      return parseUseMapping(text).map((entry) => ({ ...entry, sourcePath }));
    } catch (error) {
      diagnostics.push(parseDiagnostic(error, sourcePath));
      return [];
    }
  });
  const global = parseGlobalConfig(
    loaded.yamlProgram.globalYaml,
    diagnostics,
    loaded.potemkinConfigPath,
  );
  const yamlEvents = [
    ...fallbackEvents,
    ...boundaryConfigs.flatMap(({ config, sourcePath }) =>
      eventModelsFromConfig(config.boundary, config.eventCatalog, sourcePath),
    ),
    ...componentConfigs.flatMap(({ config, sourcePath }) =>
      eventModelsFromConfig(config.name, config.eventCatalog ?? [], sourcePath),
    ),
  ];
  const typescriptAuthoring = await authoringModelsFromTypeScript(loaded, overrides.documents);
  const typescriptEvents = typescriptAuthoring.events;
  const uniqueEvents = new Map<string, ScenarioEventModel>();
  for (const event of [...yamlEvents, ...typescriptEvents]) {
    const key = `${event.boundary}:${event.type}`;
    const previous = uniqueEvents.get(key);
    uniqueEvents.set(key, {
      boundary: event.boundary,
      type: event.type,
      fields: [...new Set([...(previous?.fields ?? []), ...event.fields])].sort(),
      ...(event.fieldTypes === undefined && previous?.fieldTypes === undefined
        ? {}
        : { fieldTypes: { ...previous?.fieldTypes, ...event.fieldTypes } }),
      ...(event.schemaRef === undefined && previous?.schemaRef === undefined
        ? {}
        : { schemaRef: event.schemaRef ?? previous?.schemaRef }),
      ...(event.sourcePath === undefined && previous?.sourcePath === undefined
        ? {}
        : { sourcePath: event.sourcePath ?? previous?.sourcePath }),
      ...(event.location === undefined && previous?.location === undefined
        ? {}
        : { location: event.location ?? previous?.location }),
    });
  }
  const events = [...uniqueEvents.values()];
  const eventTypes = [...new Set(events.map((event) => event.type))].sort();
  const eventSelectors = events
    .flatMap((event) => [
      event.type,
      ...(event.boundary === '' ? [] : [`${event.boundary}:${event.type}`]),
    ])
    .sort();
  const boundaries = boundaryConfigs.map(({ config, sourcePath }) =>
    boundaryModel(config, sourcePath),
  );
  const components = [
    ...componentConfigs.map(({ config, sourcePath }) => componentModel(config, sourcePath)),
    ...typescriptAuthoring.components,
  ];
  const behaviors = [
    ...fallbackBehaviors,
    ...boundaryConfigs.flatMap(({ config, sourcePath }) =>
      config.behaviors.map((behavior) => behaviorModel(config.boundary, behavior, sourcePath)),
    ),
  ];
  const reducers = [
    ...fallbackReducers,
    ...boundaryConfigs.flatMap(({ config, sourcePath }) =>
      config.reducers.map((reducer) => reducerModel(config.boundary, reducer, sourcePath)),
    ),
  ];
  const queries = boundaryConfigs.flatMap(({ config, sourcePath }) =>
    config.query === undefined ? [] : [queryModel(config.boundary, config.query, sourcePath)],
  );
  const references = [
    ...boundaries.flatMap((boundary) => [
      reference('boundary', boundary.name, boundary.sourceLocation),
      reference('operation', boundary.contractPath, boundary.sourceLocation),
      ...(boundary.schema === undefined
        ? []
        : [reference('schema', boundary.schema, boundary.sourceLocation)]),
      ...boundary.eventTypes.map((event) => reference('event', event, boundary.sourceLocation)),
      ...boundary.behaviorNames.map((behavior) =>
        reference('operation', behavior, boundary.sourceLocation),
      ),
      ...boundary.reducerEventTypes.map((event) =>
        reference('event', event, boundary.sourceLocation),
      ),
      ...boundary.includes.map((component) =>
        reference('component', component, boundary.sourceLocation),
      ),
    ]),
    ...components.flatMap((component) => [
      reference('component', component.name, component.sourceLocation),
      ...component.includes.map((include) =>
        reference('component', include, component.sourceLocation),
      ),
      ...component.uses.map((use) => reference('component', use, component.sourceLocation)),
    ]),
    ...uses.map((use) => reference('component', use.component, location(use.sourcePath))),
    ...operations.map((operation) => reference('operation', operation.operationId)),
    ...schemas.map((schema) => reference('schema', schema)),
  ];
  const reactions = [
    ...boundaryConfigs.flatMap(({ config, sourcePath }) =>
      (config.reactions ?? []).map((reaction) => reactionModel(reaction, sourcePath)),
    ),
    ...(global.reactions ?? []).map((reaction) =>
      reactionModel(reaction, loaded.potemkinConfigPath),
    ),
  ];
  const projections = (global.derivedProjections ?? []).map(projectionModel);
  const sagas = (global.sagas ?? []).map(sagaModel);
  const webhooks = (global.webhooks ?? []).map(webhookModel);
  const projectFeatures = projectFeatureModels(loaded.configuration);
  return {
    paths: Object.keys(openapi.paths).sort(),
    operations: operations.sort((left, right) => left.operationId.localeCompare(right.operationId)),
    operationIds: [...operationIds].sort(),
    schemas: schemas.sort(),
    events,
    boundaries,
    components,
    resources: [
      ...boundaryConfigs.flatMap(({ config, sourcePath }) => resourceModel(config, sourcePath)),
      ...typescriptAuthoring.resources,
    ],
    references,
    diagnostics,
    behaviors,
    reducers,
    queries,
    reactions,
    projections,
    sagas,
    webhooks,
    policies: { global },
    projectFeatures,
    uses: uses.map(({ sourcePath: _sourcePath, ...entry }) => entry),
    eventTypes,
    eventSelectors,
  };
}

function projectFeatureModels(
  configuration: LoadedConfig['configuration'] | undefined,
): readonly ScenarioProjectFeature[] {
  const config = configuration ?? { version: 1, specmatic: '', modules: [] };
  return [
    {
      name: 'specmatic',
      owner: 'specmatic-plugin',
      configured: config.specmatic.length > 0,
      surfaces: ['yaml-schema', 'language-server', 'plugin'],
      reason: 'Specmatic contract discovery and forwarding are owned by the plugin boundary.',
    },
    {
      name: 'modules',
      owner: 'potemkin-runtime',
      configured: config.modules.length > 0,
      surfaces: ['yaml-schema', 'language-server', 'runtime'],
      reason:
        'Module globs select Potemkin authoring inputs for the source-independent runtime model.',
    },
    {
      name: 'openapi',
      owner: 'potemkin-runtime',
      configured: (config.openapi?.length ?? 0) > 0,
      surfaces: ['yaml-schema', 'language-server', 'runtime'],
      reason: 'OpenAPI documents provide contract paths, operations, and schema references.',
    },
    {
      name: 'typescript',
      owner: 'potemkin-runtime',
      configured: config.typescript !== undefined,
      surfaces: ['yaml-schema', 'language-server', 'runtime'],
      reason: 'TypeScript scan settings select direct authoring inputs for the runtime model.',
    },
    {
      name: 'plugin',
      owner: 'specmatic-plugin',
      configured: config.plugin !== undefined,
      surfaces: ['yaml-schema', 'language-server', 'plugin'],
      reason:
        'Plugin transport, resilience, discovery, and authentication settings are consumed by the plugin.',
    },
    {
      name: 'seeds',
      owner: 'specmatic-plugin',
      configured: config.seeds !== undefined,
      surfaces: ['yaml-schema', 'language-server', 'plugin'],
      reason:
        'Seeds are forwarded as Specmatic fixtures; they are not simulation-definition state.',
    },
    {
      name: 'workflow',
      owner: 'specmatic-plugin',
      configured: config.workflow !== undefined,
      surfaces: ['yaml-schema', 'language-server', 'plugin'],
      reason:
        'Workflow identifiers are interpreted by Specmatic forwarding and are not runtime behavior declarations.',
    },
    {
      name: 'overlay',
      owner: 'specmatic-plugin',
      configured: config.overlay !== undefined,
      surfaces: ['yaml-schema', 'language-server', 'plugin'],
      reason:
        'Overlays modify the contract served by Specmatic and do not mutate the Potemkin runtime model.',
    },
    {
      name: 'governance',
      owner: 'specmatic-plugin',
      configured: config.governance !== undefined,
      surfaces: ['yaml-schema', 'language-server', 'plugin'],
      reason:
        'Governance reporting and success criteria are Specmatic project controls, not runtime policy.',
    },
  ];
}

function eventModelsFromConfig(
  boundary: string,
  catalog: readonly {
    readonly type: string;
    readonly payloadTemplate: Record<string, unknown>;
    readonly schemaRef?: string;
  }[],
  sourcePath: string,
): readonly ScenarioEventModel[] {
  return catalog.map((event) => ({
    boundary,
    type: event.type,
    fields: Object.keys(event.payloadTemplate).sort(),
    ...(Object.keys(event.payloadTemplate).length === 0
      ? {}
      : {
          fieldTypes: Object.fromEntries(
            Object.keys(event.payloadTemplate).map((key) => [key, 'unknown' as const]),
          ),
        }),
    ...(event.schemaRef === undefined ? {} : { schemaRef: event.schemaRef }),
    sourcePath,
    location: location(sourcePath),
  }));
}

/**
 * Preserve declarations from an otherwise invalid editor buffer. The
 * semantic parser remains authoritative; this structural pass only keeps
 * symbols such as event catalog entries visible so diagnostics and
 * completions can explain the invalid reference instead of hiding the file.
 */
function unvalidatedYamlSymbols(
  text: string,
  sourcePath: string,
): {
  readonly events: readonly ScenarioEventModel[];
  readonly behaviors: readonly ScenarioBehaviorModel[];
  readonly reducers: readonly ScenarioReducerModel[];
} {
  let value: unknown;
  try {
    value = parseScenarioYaml(text);
  } catch {
    return { events: [], behaviors: [], reducers: [] };
  }
  const record = asRecord(value);
  const boundary = typeof record['boundary'] === 'string' ? record['boundary'] : '';
  const catalog = Array.isArray(record['event_catalog']) ? record['event_catalog'] : [];
  const events = catalog.flatMap((entry) => {
    const event = asRecord(entry);
    if (typeof event['type'] !== 'string') return [];
    const payload = asRecord(event['payload_template']);
    return [
      {
        boundary,
        type: event['type'],
        fields: Object.keys(payload).sort(),
        ...(typeof event['schema_ref'] === 'string' ? { schemaRef: event['schema_ref'] } : {}),
        sourcePath,
        location: location(sourcePath),
      },
    ];
  });
  const behaviors = (Array.isArray(record['behaviors']) ? record['behaviors'] : []).flatMap(
    (entry) => {
      const raw = asRecord(entry);
      if (typeof raw['name'] !== 'string') return [];
      const match = asRecord(raw['match']);
      const operationId = typeof match['operationId'] === 'string' ? match['operationId'] : '';
      return [
        {
          boundary,
          name: raw['name'],
          operationId,
          condition: typeof match['condition'] === 'string' ? match['condition'] : '',
          requires: [],
          emissions: typeof raw['emit'] === 'string' ? [{ event: raw['emit'] }] : [],
          dispatches: [],
          sourceLocation: location(sourcePath),
        },
      ];
    },
  );
  const reducers = (Array.isArray(record['reducers']) ? record['reducers'] : []).flatMap(
    (entry) => {
      const raw = asRecord(entry);
      if (typeof raw['on'] !== 'string') return [];
      return [
        {
          boundary,
          on: raw['on'],
          replaceState: raw['replace_state'] === true,
          patches: [],
          sourceLocation: location(sourcePath),
        },
      ];
    },
  );
  return { events, behaviors, reducers };
}

function boundaryModel(config: BoundaryConfig, sourcePath: string): ScenarioBoundaryModel {
  return {
    name: config.boundary,
    contractPath: config.contractPath,
    sourcePath,
    eventTypes: config.eventCatalog.map((event) => event.type),
    behaviorNames: config.behaviors.map((behavior) => behavior.name),
    reducerEventTypes: config.reducers.map((reducer) => reducer.on),
    includes: (config.include ?? []).map((include) => include.component),
    ...(config.schema === undefined ? {} : { schema: config.schema }),
    initializationCount: config.initialization?.length ?? 0,
    ...(config.identity === undefined ? {} : { identity: config.identity }),
    ...(config.query === undefined ? {} : { query: config.query }),
    sourceLocation: location(sourcePath),
  };
}

function componentModel(config: ComponentDefinition, sourcePath: string): ScenarioComponentModel {
  return {
    name: config.name,
    sourcePath,
    includes: (config.include ?? []).map((include) => include.component),
    uses: [],
    eventTypes: (config.eventCatalog ?? []).map((event) => event.type),
    behaviorNames: (config.behaviors ?? []).map((behavior) => behavior.name),
    reducerEventTypes: (config.reducers ?? []).map((reducer) => reducer.on),
    ...(config.schema === undefined ? {} : { schema: config.schema }),
    ...(config.parameters === undefined
      ? {}
      : { parameters: Object.keys(config.parameters).sort() }),
    ...(config.identity === undefined ? {} : { identity: config.identity }),
    ...(config.query === undefined ? {} : { query: config.query }),
    sourceLocation: location(sourcePath),
  };
}

function resourceModel(
  config: BoundaryConfig,
  sourcePath: string,
): readonly ScenarioResourceModel[] {
  return config.schema === undefined
    ? []
    : [
        {
          name: config.boundary,
          schema: config.schema,
          operationIds: config.behaviors.map((behavior) => behavior.match.operationId),
          sourcePath,
        },
      ];
}

function behaviorModel(
  boundary: string,
  behavior: BehaviorRule,
  sourcePath: string,
): ScenarioBehaviorModel {
  return {
    boundary,
    name: behavior.name,
    operationId: behavior.match.operationId,
    condition: behavior.match.condition,
    requires: (behavior.match.requires ?? []).map((guard) => ({
      name: guard.name,
      condition: guard.condition,
      errorCode: guard.errorCode,
      errorMessage: guard.errorMessage,
      ...(guard.errorStatus === undefined ? {} : { errorStatus: guard.errorStatus }),
    })),
    emissions: [
      ...(behavior.emit === undefined ? [] : [{ event: behavior.emit }]),
      ...(behavior.emitWhen ?? []).map((emission) => ({
        event: emission.emit,
        when: emission.when,
      })),
    ],
    dispatches: (behavior.dispatchCommands ?? []).map((dispatch) => ({
      boundary: dispatch.boundary,
      intent: dispatch.intent,
      operationId: dispatch.operationId,
      payloadKeys: Object.keys(dispatch.payload ?? {}).sort(),
      ...(dispatch.targetId === undefined ? {} : { targetId: dispatch.targetId }),
      ...(dispatch.condition === undefined ? {} : { condition: dispatch.condition }),
    })),
    sourceLocation: location(sourcePath),
  };
}

function reducerModel(
  boundary: string,
  reducer: ReducerRule,
  sourcePath: string,
): ScenarioReducerModel {
  return {
    boundary,
    on: reducer.on,
    replaceState: reducer.replaceState === true,
    patches: (reducer.patches ?? []).map((patch) => ({
      op: patch.op,
      path: patch.path,
      ...(patch.from === undefined ? {} : { from: patch.from }),
    })),
    sourceLocation: location(sourcePath),
  };
}

function queryModel(
  boundary: string,
  query: NonNullable<BoundaryConfig['query']>,
  sourcePath: string,
): ScenarioQueryModel {
  return {
    boundary,
    fields: Object.keys(query.fields ?? {}).sort(),
    sort: query.sort ?? [],
    expand: query.expand ?? [],
    ...(query.filter === undefined ? {} : { filter: query.filter }),
    sourceLocation: location(sourcePath),
  };
}

function reactionModel(reaction: ReactionRule, sourcePath: string): ScenarioReactionModel {
  return {
    ...(reaction.name === undefined ? {} : { name: reaction.name }),
    on: reaction.on,
    ...(reaction.boundary === undefined ? {} : { boundary: reaction.boundary }),
    emit: reaction.emit,
    intent: reaction.intent ?? 'mutation',
    sourceLocation: location(sourcePath),
  };
}

function projectionModel(projection: DerivedProjectionConfig): ScenarioProjectionModel {
  return {
    name: projection.name,
    subscribe: projection.subscribe,
    reducedEventTypes: projection.reduce.map((entry) => entry.on),
    patchPaths: projection.reduce.flatMap((entry) =>
      (entry.patches ?? []).map((patch) => patch.path),
    ),
  };
}

function sagaModel(saga: SagaConfig): ScenarioSagaModel {
  return {
    name: saga.name,
    triggerBoundary: saga.trigger.boundary,
    triggerIntent: saga.trigger.intent,
    stepNames: saga.steps.map((step) => step.name),
    operationIds: saga.steps.map((step) => step.operationId),
  };
}

function webhookModel(webhook: WebhookConfig): ScenarioWebhookModel {
  return {
    name: webhook.name,
    ...(webhook.trigger.boundary === undefined ? {} : { boundary: webhook.trigger.boundary }),
    ...(webhook.trigger.intent === undefined ? {} : { intent: webhook.trigger.intent }),
  };
}

function reference(
  kind: ScenarioReferenceKind,
  name: string,
  sourceLocation?: ScenarioSourceLocation,
): ScenarioReference {
  return { kind, name, ...(sourceLocation === undefined ? {} : { location: sourceLocation }) };
}

function location(sourcePath: string): ScenarioSourceLocation {
  return { sourcePath };
}

function parseDiagnostic(error: unknown, sourcePath: string): ScenarioDiagnostic {
  return {
    code:
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : 'SCENARIO_PARSE_ERROR',
    severity: 'error',
    message: error instanceof Error ? error.message : String(error),
    location: location(sourcePath),
  };
}

function parseGlobalConfig(
  text: string | undefined,
  diagnostics: ScenarioDiagnostic[],
  sourcePath: string,
): GlobalConfig {
  if (text === undefined) return {};
  try {
    return validateGlobalConfig(parseScenarioYaml(text));
  } catch (error) {
    diagnostics.push(parseDiagnostic(error, sourcePath));
    return {};
  }
}

interface TypeScriptAuthoringModels {
  readonly events: readonly ScenarioEventModel[];
  readonly components: readonly ScenarioComponentModel[];
  readonly resources: readonly ScenarioResourceModel[];
}

async function authoringModelsFromTypeScript(
  loaded: LoadedConfig,
  documents?: ReadonlyMap<string, string>,
): Promise<TypeScriptAuthoringModels> {
  const configuration = loaded.typescript;
  if (configuration === undefined) return { events: [], components: [], resources: [] };
  const cwd = path.dirname(loaded.potemkinConfigPath);
  const patterns = configuration.scan.flatMap((entry) => entry.include);
  const ignored = configuration.scan.flatMap((entry) => entry.exclude ?? []);
  const files = await glob(patterns, {
    cwd,
    absolute: true,
    onlyFiles: true,
    ignore: ignored,
  });
  const uniqueFiles = [...new Set(files.map((file) => path.resolve(file)))].sort();
  const events: ScenarioEventModel[] = [];
  const components: ScenarioComponentModel[] = [];
  const resources: ScenarioResourceModel[] = [];
  for (const file of uniqueFiles) {
    const source = documents?.get(path.resolve(file)) ?? (await readSource(file));
    if (source === undefined) continue;
    events.push(...extractTypeScriptEvents(source, file));
    const authoring = extractTypeScriptDefinitions(source, file);
    components.push(...authoring.components);
    resources.push(...authoring.resources);
  }
  return { events, components, resources };
}

async function readSource(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

function schemaReference(schema: JsonObject): JsonSchemaReference {
  return {
    ...(typeof schema['type'] === 'string' ? { type: schema['type'] } : {}),
    ...(typeof schema['$ref'] === 'string' ? { reference: schema['$ref'] } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function parseScenarioYaml(text: string): unknown {
  return parse(text, {
    schema: 'core',
    merge: true,
    customTags: ['timestamp'],
  });
}

function isHttpMethod(value: string): value is HttpMethod {
  return HTTP_METHOD_VALUES.has(value);
}
