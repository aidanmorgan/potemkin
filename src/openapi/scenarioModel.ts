import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as ts from 'typescript';
import * as yaml from 'js-yaml';
import { glob } from 'tinyglobby';

import type { OpenApiDoc } from '../contract/loader.js';
import type { LoadedConfig } from '../parser/configLoader.js';
import type { JsonObject } from '../contracts/value.js';
import type {
  Diagnostic,
  DiagnosticSeverity,
  SourceLocation,
  SourcePosition,
} from '../contracts/diagnostics.js';
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

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- domain name for the shared source-position contract.
export interface ScenarioSourcePosition extends SourcePosition {}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- domain name for the shared source-location contract.
export interface ScenarioSourceLocation extends SourceLocation {}

export type ScenarioDiagnosticSeverity = DiagnosticSeverity;

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- scenario diagnostics use the shared diagnostic shape.
export interface ScenarioDiagnostic extends Diagnostic {}

export type ScenarioReferenceKind =
  | 'boundary'
  | 'component'
  | 'event'
  | 'operation'
  | 'resource'
  | 'schema'
  | 'saga'
  | 'projection';

export interface ScenarioReference {
  readonly kind: ScenarioReferenceKind;
  readonly name: string;
  readonly target?: string;
  readonly location?: ScenarioSourceLocation;
}

export interface ScenarioEventModel {
  readonly boundary: string;
  readonly type: string;
  readonly fields: readonly string[];
  /** Best-effort source-level types used when no OpenAPI schema is attached. */
  readonly fieldTypes?: Readonly<Record<string, ScenarioFieldType>>;
  readonly schemaRef?: string;
  readonly sourcePath?: string;
  readonly location?: ScenarioSourceLocation;
}

export type ScenarioFieldType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'unknown';

export interface ScenarioOperationModel {
  readonly operationId: string;
  readonly path: string;
  readonly method: string;
  readonly parameters: readonly string[];
  readonly requestSchema?: JsonSchemaReference;
  readonly responseSchemas: Readonly<Record<string, JsonSchemaReference>>;
}

export interface JsonSchemaReference {
  readonly type?: string;
  readonly reference?: string;
}

export interface ScenarioBoundaryModel {
  readonly name: string;
  readonly contractPath: string;
  readonly sourcePath?: string;
  readonly eventTypes: readonly string[];
  readonly behaviorNames: readonly string[];
  readonly reducerEventTypes: readonly string[];
  readonly includes: readonly string[];
  readonly schema?: string;
  readonly initializationCount: number;
  readonly identity?: BoundaryConfig['identity'];
  readonly query?: BoundaryConfig['query'];
  readonly sourceLocation?: ScenarioSourceLocation;
}

export interface ScenarioGuardModel {
  readonly name: string;
  readonly condition: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly errorStatus?: number;
}

export interface ScenarioEmissionModel {
  readonly event: string;
  readonly when?: string;
}

export interface ScenarioDispatchModel {
  readonly boundary: string;
  readonly intent: string;
  readonly operationId: string;
  readonly payloadKeys: readonly string[];
  readonly targetId?: string;
  readonly condition?: string;
}

export interface ScenarioBehaviorModel {
  readonly boundary: string;
  readonly name: string;
  readonly operationId: string;
  readonly condition: string;
  readonly requires: readonly ScenarioGuardModel[];
  readonly emissions: readonly ScenarioEmissionModel[];
  readonly dispatches: readonly ScenarioDispatchModel[];
  readonly sourceLocation?: ScenarioSourceLocation;
}

export interface ScenarioReducerPatchModel {
  readonly op: string;
  readonly path: string;
  readonly from?: string;
}

export interface ScenarioReducerModel {
  readonly boundary: string;
  readonly on: string;
  readonly replaceState: boolean;
  readonly patches: readonly ScenarioReducerPatchModel[];
  readonly sourceLocation?: ScenarioSourceLocation;
}

export interface ScenarioQueryModel {
  readonly boundary: string;
  readonly fields: readonly string[];
  readonly sort: readonly { readonly field: string; readonly direction?: 'asc' | 'desc' }[];
  readonly expand: readonly string[];
  readonly filter?: string;
  readonly sourceLocation?: ScenarioSourceLocation;
}

export interface ScenarioComponentModel {
  readonly name: string;
  readonly sourcePath?: string;
  readonly includes: readonly string[];
  readonly uses: readonly string[];
  readonly eventTypes?: readonly string[];
  readonly behaviorNames?: readonly string[];
  readonly reducerEventTypes?: readonly string[];
  readonly schema?: string;
  readonly parameters?: readonly string[];
  readonly identity?: ComponentDefinition['identity'];
  readonly query?: ComponentDefinition['query'];
  readonly sourceLocation?: ScenarioSourceLocation;
}

export interface ScenarioResourceModel {
  readonly name: string;
  readonly schema: string;
  readonly operationIds: readonly string[];
  readonly sourcePath?: string;
}

export interface ScenarioReactionModel {
  readonly name?: string;
  readonly on: string;
  readonly boundary?: string;
  readonly emit: string;
  readonly intent: string;
  readonly sourceLocation?: ScenarioSourceLocation;
}

export interface ScenarioProjectionModel {
  readonly name: string;
  readonly subscribe: readonly string[];
  readonly reducedEventTypes: readonly string[];
  readonly patchPaths: readonly string[];
}

export interface ScenarioSagaModel {
  readonly name: string;
  readonly triggerBoundary: string;
  readonly triggerIntent: string;
  readonly stepNames: readonly string[];
  readonly operationIds: readonly string[];
}

export interface ScenarioWebhookModel {
  readonly name: string;
  readonly boundary?: string;
  readonly intent?: string;
}

export interface ScenarioPolicyModel {
  readonly global: GlobalConfig;
}

export type ScenarioProjectFeatureName =
  | 'specmatic'
  | 'modules'
  | 'openapi'
  | 'typescript'
  | 'plugin'
  | 'seeds'
  | 'workflow'
  | 'overlay'
  | 'governance';

export type ScenarioProjectFeatureOwner = 'potemkin-runtime' | 'specmatic-plugin';

/**
 * Explicit project-configuration classification for editor and generator
 * consumers. Values from plugin-owned blocks are deliberately not copied into
 * this descriptor: the descriptor records where they are validated and which
 * process owns their effects, without turning plugin configuration into SDK
 * runtime state or exposing credentials.
 */
export interface ScenarioProjectFeature {
  readonly name: ScenarioProjectFeatureName;
  readonly owner: ScenarioProjectFeatureOwner;
  readonly configured: boolean;
  readonly surfaces: readonly ('yaml-schema' | 'language-server' | 'runtime' | 'plugin')[];
  readonly reason: string;
}

export interface ScenarioSourceOverrides {
  /** Unsaved editor buffers keyed by their absolute source path. */
  readonly documents?: ReadonlyMap<string, string>;
}

export interface ScenarioModel {
  readonly paths: readonly string[];
  readonly operations?: readonly ScenarioOperationModel[];
  readonly operationIds: readonly string[];
  readonly schemas: readonly string[];
  readonly events: readonly ScenarioEventModel[];
  readonly boundaries?: readonly ScenarioBoundaryModel[];
  readonly components?: readonly ScenarioComponentModel[];
  readonly resources?: readonly ScenarioResourceModel[];
  readonly references: readonly ScenarioReference[];
  readonly diagnostics: readonly ScenarioDiagnostic[];
  readonly behaviors: readonly ScenarioBehaviorModel[];
  readonly reducers: readonly ScenarioReducerModel[];
  readonly queries: readonly ScenarioQueryModel[];
  readonly reactions: readonly ScenarioReactionModel[];
  readonly projections: readonly ScenarioProjectionModel[];
  readonly sagas: readonly ScenarioSagaModel[];
  readonly webhooks: readonly ScenarioWebhookModel[];
  readonly policies: ScenarioPolicyModel;
  readonly projectFeatures: readonly ScenarioProjectFeature[];
  readonly uses: readonly {
    readonly component: string;
    readonly as: string;
    readonly contractPath: string;
  }[];
  readonly eventTypes: readonly string[];
  readonly eventSelectors: readonly string[];
}

/** Build the shared contract-plus-authoring graph used by both IDE generators. */
export async function collectScenarioModel(
  openapi: OpenApiDoc,
  loaded: LoadedConfig,
  overrides: ScenarioSourceOverrides = {},
): Promise<ScenarioModel> {
  const operationIds = new Set<string>();
  const operations: ScenarioOperationModel[] = [];
  for (const item of Object.values(openapi.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (operation?.operationId !== undefined) {
        operationIds.add(operation.operationId);
        operations.push({
          operationId: operation.operationId,
          path: Object.keys(openapi.paths).find((path) => openapi.paths[path] === item) ?? '',
          method: method.toUpperCase(),
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
    config.query === undefined ? [] : [queryModel(config.boundary, config, sourcePath)],
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
    value = yaml.load(text);
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
  config: BoundaryConfig,
  sourcePath: string,
): ScenarioQueryModel {
  const query = config.query!;
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
    return validateGlobalConfig(yaml.load(text));
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

function extractTypeScriptEvents(source: string, fileName: string): readonly ScenarioEventModel[] {
  const script = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const events: ScenarioEventModel[] = [];
  const eventDeclarations = new Map<string, ScenarioEventModel>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const declaration = ts.isCallExpression(node.initializer)
        ? calledName(node.initializer.expression) === 'event'
          ? eventFromCall(node.initializer)
          : calledName(node.initializer.expression) === 'defineEvent'
            ? eventFromDefinition(node.initializer)
            : undefined
        : undefined;
      if (declaration !== undefined) eventDeclarations.set(node.name.text, declaration);
    }
    if (ts.isCallExpression(node)) {
      const name = calledName(node.expression);
      if (name === 'event') {
        const extracted = eventFromCall(node);
        if (extracted !== undefined) events.push(extracted);
      } else if (name === 'defineEvent') {
        const extracted = eventFromDefinition(node);
        if (extracted !== undefined) events.push(extracted);
      } else if (name === 'eventType' && isEventTypeDeclaration(node)) {
        const type = stringLiteral(node.arguments[0]);
        if (type !== undefined) {
          events.push({
            boundary: '',
            type,
            fields: [],
            sourcePath: fileName,
            location: locationForNode(node),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(script);
  const composedEvents: ScenarioEventModel[] = [];
  const visitComposition = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && calledName(node.expression) === 'boundary') {
      const boundary = staticAuthoringName(node.arguments[0], 'boundaryName');
      if (boundary !== undefined) {
        for (const argument of chainedMethodArguments(node, 'eventCatalog')) {
          const declaration = ts.isIdentifier(argument)
            ? eventDeclarations.get(argument.text)
            : ts.isCallExpression(argument)
              ? calledName(argument.expression) === 'event'
                ? eventFromCall(argument)
                : calledName(argument.expression) === 'defineEvent'
                  ? eventFromDefinition(argument)
                  : undefined
              : undefined;
          if (declaration !== undefined) composedEvents.push({ ...declaration, boundary });
        }
      }
    }
    ts.forEachChild(node, visitComposition);
  };
  visitComposition(script);
  return [...events, ...composedEvents];
}

function chainedMethodArguments(
  root: ts.CallExpression,
  methodName: string,
): readonly ts.Expression[] {
  const argumentsFound: ts.Expression[] = [];
  let current: ts.Node = root;
  while (current.parent !== undefined) {
    const access = current.parent;
    if (!ts.isPropertyAccessExpression(access) || access.expression !== current) break;
    const call = access.parent;
    if (!ts.isCallExpression(call) || call.expression !== access) break;
    if (access.name.text === methodName) argumentsFound.push(...call.arguments);
    current = call;
  }
  return argumentsFound;
}

function staticAuthoringName(node: ts.Expression | undefined, wrapper: string): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isCallExpression(node) && calledName(node.expression) === wrapper) {
    return stringLiteral(node.arguments[0]);
  }
  return undefined;
}

function extractTypeScriptDefinitions(
  source: string,
  fileName: string,
): {
  readonly components: readonly ScenarioComponentModel[];
  readonly resources: readonly ScenarioResourceModel[];
} {
  const script = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const components: ScenarioComponentModel[] = [];
  const resources: ScenarioResourceModel[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calledName(node.expression);
      if (name === 'defineComponent') {
        const componentName = staticAuthoringName(node.arguments[0], 'componentName');
        if (componentName !== undefined) {
          const sourceObject = node.arguments[1];
          components.push({
            name: componentName,
            sourcePath: fileName,
            includes: [],
            uses: [],
            eventTypes: collectWrappedStringCalls(sourceObject, 'eventType'),
            reducerEventTypes: collectWrappedStringCalls(sourceObject, 'eventType'),
            behaviorNames: collectWrappedStringCalls(sourceObject, 'behaviorName'),
            sourceLocation: locationForNode(node),
          });
        }
      } else if (name === 'defineResource') {
        const resourceName = staticAuthoringName(node.arguments[0], 'resourceName');
        if (resourceName !== undefined) {
          const sourceObject = node.arguments[1];
          resources.push({
            name: resourceName,
            schema: collectWrappedStringCalls(sourceObject, 'schemaReference')[0] ?? resourceName,
            operationIds: collectWrappedStringCalls(sourceObject, 'operationId'),
            sourcePath: fileName,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(script);
  return { components, resources };
}

function collectWrappedStringCalls(node: ts.Node | undefined, wrapper: string): readonly string[] {
  if (node === undefined) return [];
  const values: string[] = [];
  const visit = (current: ts.Node): void => {
    if (
      ts.isCallExpression(current) &&
      calledName(current.expression) === wrapper &&
      stringLiteral(current.arguments[0]) !== undefined
    ) {
      values.push(stringLiteral(current.arguments[0])!);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return [...new Set(values)].sort();
}

function isEventTypeDeclaration(node: ts.CallExpression): boolean {
  return (
    ts.isVariableDeclaration(node.parent) &&
    node.parent.initializer === node &&
    ts.isIdentifier(node.parent.name)
  );
}

function eventFromCall(node: ts.CallExpression): ScenarioEventModel | undefined {
  const typeExpression = node.arguments[0];
  if (
    !ts.isCallExpression(typeExpression) ||
    calledName(typeExpression.expression) !== 'eventType'
  ) {
    return undefined;
  }
  const type = stringLiteral(typeExpression.arguments[0]);
  if (type === undefined) return undefined;
  return {
    boundary: '',
    type,
    fields: objectKeys(node.arguments[1]),
    fieldTypes: objectFieldTypes(node.arguments[1]),
    sourcePath: fileNameForNode(node),
    location: locationForNode(node),
  };
}

function eventFromDefinition(node: ts.CallExpression): ScenarioEventModel | undefined {
  const object = node.arguments[0];
  if (!ts.isObjectLiteralExpression(object)) return undefined;
  const typeProperty = property(object, 'type');
  const typeCall = typeProperty?.initializer;
  if (
    !typeCall ||
    !ts.isCallExpression(typeCall) ||
    calledName(typeCall.expression) !== 'eventType'
  ) {
    return undefined;
  }
  const type = stringLiteral(typeCall.arguments[0]);
  if (type === undefined) return undefined;
  const payload = property(object, 'payload')?.initializer;
  return {
    boundary: '',
    type,
    fields: objectKeys(payload),
    fieldTypes: objectFieldTypes(payload),
    sourcePath: fileNameForNode(node),
    location: locationForNode(node),
  };
}

function fileNameForNode(node: ts.Node): string | undefined {
  return node.getSourceFile().fileName;
}

function locationForNode(node: ts.Node): ScenarioSourceLocation {
  const source = node.getSourceFile();
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  const end = source.getLineAndCharacterOfPosition(node.getEnd());
  return {
    sourcePath: source.fileName,
    start: { line: start.line, column: start.character, offset: node.getStart(source) },
    end: { line: end.line, column: end.character, offset: node.getEnd() },
  };
}

function schemaReference(schema: JsonObject): JsonSchemaReference {
  const value = asRecord(schema);
  return {
    ...(typeof value['type'] === 'string' ? { type: value['type'] } : {}),
    ...(typeof value['$ref'] === 'string' ? { reference: value['$ref'] } : {}),
  };
}

function calledName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function stringLiteral(node: ts.Node | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteral(node) ? node.text : undefined;
}

function objectKeys(node: ts.Node | undefined): readonly string[] {
  if (!node || !ts.isObjectLiteralExpression(node)) return [];
  return node.properties.flatMap((entry) => {
    if (!ts.isPropertyAssignment(entry) && !ts.isShorthandPropertyAssignment(entry)) return [];
    const name = entry.name;
    if (name === undefined) return [];
    return [ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined].filter(
      (value): value is string => value !== undefined,
    );
  });
}

function objectFieldTypes(node: ts.Node | undefined): Readonly<Record<string, ScenarioFieldType>> {
  if (node === undefined || !ts.isObjectLiteralExpression(node)) return {};
  return Object.fromEntries(
    node.properties.flatMap((entry) => {
      if (!ts.isPropertyAssignment(entry) && !ts.isShorthandPropertyAssignment(entry)) return [];
      const name = entry.name;
      const key =
        name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name))
          ? name.text
          : undefined;
      if (key === undefined) return [];
      return [
        [key, inferTypeScriptType(ts.isPropertyAssignment(entry) ? entry.initializer : undefined)],
      ] as const;
    }),
  );
}

function inferTypeScriptType(node: ts.Node | undefined): ScenarioFieldType {
  if (node === undefined) return 'unknown';
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return 'string';
  if (ts.isNumericLiteral(node)) return 'number';
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword)
    return 'boolean';
  if (ts.isArrayLiteralExpression(node)) return 'array';
  if (ts.isObjectLiteralExpression(node)) return 'object';
  return 'unknown';
}

function property(
  node: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined {
  return node.properties.find((entry): entry is ts.PropertyAssignment => {
    if (!ts.isPropertyAssignment(entry)) return false;
    const propertyName = entry.name;
    return (
      propertyName !== undefined && ts.isIdentifier(propertyName) && propertyName.text === name
    );
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
