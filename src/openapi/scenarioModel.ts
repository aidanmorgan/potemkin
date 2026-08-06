import type {
  Diagnostic,
  DiagnosticSeverity,
  SourceLocation,
  SourcePosition,
} from '../contracts/diagnostics.js';
import type { OpenApiDoc } from '../contract/loader.js';
import type { LoadedConfig } from '../parser/configLoader.js';
import type { BoundaryConfig, ComponentDefinition } from '../dsl/types.js';
import type { GlobalConfig } from '../dsl/schema.js';
import type { HttpMethod } from '../domain/references.js';
import { collectScenarioModel as buildScenarioModel } from './scenarioModelBuilder.js';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- domain name for the shared source-position contract.
export interface ScenarioSourcePosition extends SourcePosition {}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- domain name for the shared source-location contract.
export interface ScenarioSourceLocation extends SourceLocation {}

export type ScenarioDiagnosticSeverity = DiagnosticSeverity;

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- scenario diagnostics use the shared diagnostic shape.
export interface ScenarioDiagnostic extends Diagnostic {}

export const ScenarioReferenceKind = {
  Boundary: 'boundary',
  Component: 'component',
  Event: 'event',
  Operation: 'operation',
  Resource: 'resource',
  Schema: 'schema',
  Saga: 'saga',
  Projection: 'projection',
} as const;

export type ScenarioReferenceKind =
  (typeof ScenarioReferenceKind)[keyof typeof ScenarioReferenceKind];

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

export const ScenarioFieldType = {
  String: 'string',
  Number: 'number',
  Boolean: 'boolean',
  Object: 'object',
  Array: 'array',
  Unknown: 'unknown',
} as const;

export type ScenarioFieldType = (typeof ScenarioFieldType)[keyof typeof ScenarioFieldType];

export interface ScenarioOperationModel {
  readonly operationId: string;
  readonly path: string;
  readonly method: HttpMethod;
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

export const ScenarioProjectFeatureName = {
  Specmatic: 'specmatic',
  Modules: 'modules',
  OpenApi: 'openapi',
  TypeScript: 'typescript',
  Plugin: 'plugin',
  Seeds: 'seeds',
  Workflow: 'workflow',
  Overlay: 'overlay',
  Governance: 'governance',
} as const;

export type ScenarioProjectFeatureName =
  (typeof ScenarioProjectFeatureName)[keyof typeof ScenarioProjectFeatureName];

export const ScenarioProjectFeatureOwner = {
  PotemkinRuntime: 'potemkin-runtime',
  SpecmaticPlugin: 'specmatic-plugin',
} as const;

export type ScenarioProjectFeatureOwner =
  (typeof ScenarioProjectFeatureOwner)[keyof typeof ScenarioProjectFeatureOwner];

export const ScenarioProjectFeatureSurface = {
  YamlSchema: 'yaml-schema',
  LanguageServer: 'language-server',
  Runtime: 'runtime',
  Plugin: 'plugin',
} as const;

export type ScenarioProjectFeatureSurface =
  (typeof ScenarioProjectFeatureSurface)[keyof typeof ScenarioProjectFeatureSurface];

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
  readonly surfaces: readonly ScenarioProjectFeatureSurface[];
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
  return buildScenarioModel(openapi, loaded, overrides);
}
