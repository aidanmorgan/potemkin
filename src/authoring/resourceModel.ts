import type { OpenApiDocumentDescriptor } from '../contracts/openapi.js';
import type { ComposableBoundary } from './composition.js';
import { definitionError } from './errors.js';
import type { BehaviorDefinition, IdentityDefinition } from './types.js';
import {
  behaviorName,
  boundaryName,
  httpMethod,
  parseContractPath,
  HttpMethod,
} from '../domain/references.js';
import type { ResourceDefinition, ResourceOperation } from './types.js';

export type { ResourceDefinition, ResourceOperation };

interface IndexedOperation {
  readonly path: string;
  readonly method: HttpMethod;
}

function pathSuffix(path: string): string {
  return path
    .replace(/^\//, '')
    .replace(/\{([^}]+)\}/g, 'By_$1')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_+$/g, '');
}

function hasPathParameter(path: string): boolean {
  return /\{[^}]+\}/.test(path);
}

function lastPathParameter(path: string): string | undefined {
  const matches = [...path.matchAll(/\{([^}]+)\}/g)];
  return matches.at(-1)?.[1];
}

function requiredLastPathParameter(path: string): string {
  const parameter = lastPathParameter(path);
  if (parameter === undefined) {
    throw definitionError(`Resource contract path "${path}" requires a path parameter`);
  }
  return parameter;
}

function operationIndex(
  openapi?: OpenApiDocumentDescriptor,
): ReadonlyMap<string, IndexedOperation> {
  const result = new Map<string, IndexedOperation>();
  for (const [path, item] of Object.entries(openapi?.paths ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      if (operation?.operationId !== undefined) {
        result.set(operation.operationId, { path, method: httpMethod(method) });
      }
    }
  }
  return result;
}

function resolveOperation(
  operation: ResourceOperation,
  index: ReadonlyMap<string, IndexedOperation>,
): IndexedOperation {
  const indexed = index.get(operation.operationId);
  if (indexed !== undefined) return indexed;
  if (operation.contractPath !== undefined) {
    return { path: operation.contractPath, method: operation.method ?? HttpMethod.Post };
  }
  throw definitionError(
    `Resource operation "${operation.operationId}" is not present in the OpenAPI contract`,
  );
}

function resourceBehavior(
  operation: ResourceOperation,
  resolved: IndexedOperation,
): BehaviorDefinition {
  return {
    name: behaviorName(operation.operationId),
    operationId: operation.operationId,
    method: resolved.method,
    ...operation.behavior,
    ...(operation.emit === undefined ? {} : { emit: operation.emit }),
  };
}

function resourceBoundary(
  resource: ResourceDefinition,
  path: string,
  operations: readonly ResourceOperation[],
  index: ReadonlyMap<string, IndexedOperation>,
  includeInitialization: boolean,
  includeReactions: boolean,
): ComposableBoundary {
  const collection = !hasPathParameter(path);
  const query = operations.some((operation) => operation.query === true);
  const behaviors = operations
    .filter((operation) => operation.query !== true)
    .map((operation) => resourceBehavior(operation, resolveOperation(operation, index)));
  const identity: IdentityDefinition | undefined = collection
    ? resource.identity
    : { key: { from: 'path', name: requiredLastPathParameter(path) } };

  return {
    boundary: boundaryName(`${resource.resource}__${pathSuffix(path)}`),
    contractPath: parseContractPath(path),
    schema: resource.schema,
    fallbackOverride: query,
    ...(identity === undefined ? {} : { identity }),
    ...(resource.query === undefined ? {} : { query: resource.query }),
    eventCatalog: resource.eventCatalog,
    behaviors,
    reducers: resource.reducers,
    ...(includeInitialization && resource.initialization !== undefined
      ? { initialization: resource.initialization }
      : {}),
    ...(resource.response === undefined ? {} : { response: resource.response }),
    ...(resource.mask === undefined ? {} : { mask: resource.mask }),
    ...(resource.auditFields === undefined ? {} : { auditFields: resource.auditFields }),
    ...(resource.deprecated === undefined ? {} : { deprecated: resource.deprecated }),
    ...(resource.latency === undefined ? {} : { latency: resource.latency }),
    ...(resource.state === undefined ? {} : { state: resource.state }),
    ...(resource.strictSchema === undefined ? {} : { strictSchema: resource.strictSchema }),
    ...(resource.faults === undefined ? {} : { faults: resource.faults }),
    ...(includeReactions && resource.reactions !== undefined
      ? { reactions: resource.reactions }
      : {}),
  };
}

export function expandResources(
  resources: readonly ResourceDefinition[],
  openapi?: OpenApiDocumentDescriptor,
): readonly ComposableBoundary[] {
  const index = operationIndex(openapi);
  const expanded: ComposableBoundary[] = [];
  for (const resource of resources) {
    if (resource.resource.trim() === '' || resource.schema.trim() === '') {
      throw definitionError('A resource requires non-empty resource and schema names');
    }
    if (resource.operations.length === 0) {
      throw definitionError(`Resource "${resource.resource}" requires at least one operation`);
    }
    const grouped = new Map<string, ResourceOperation[]>();
    for (const operation of resource.operations) {
      if (operation.operationId.trim() === '')
        throw definitionError(
          `Resource "${resource.resource}" has an operation without an operationId`,
        );
      if (operation.query === true && operation.emit !== undefined)
        throw definitionError(
          `Resource operation "${operation.operationId}" cannot emit and query`,
        );
      if (
        operation.query !== true &&
        operation.emit === undefined &&
        operation.behavior?.emit === undefined &&
        operation.behavior?.emitWhen === undefined &&
        operation.behavior?.dispatchCommands === undefined
      ) {
        throw definitionError(
          `Resource operation "${operation.operationId}" requires an emit or behavior dispatch`,
        );
      }
      const resolved = resolveOperation(operation, index);
      const current = grouped.get(resolved.path) ?? [];
      current.push(operation);
      grouped.set(resolved.path, current);
    }
    const collectionExists = [...grouped.keys()].some((path) => !hasPathParameter(path));
    let initialized = false;
    let reacted = false;
    for (const [path, operations] of grouped) {
      const attachInitialization: boolean =
        !initialized && (collectionExists ? !hasPathParameter(path) : expanded.length === 0);
      const attachReactions: boolean = !reacted && resource.reactions !== undefined;
      const boundary = resourceBoundary(
        resource,
        path,
        operations,
        index,
        attachInitialization,
        attachReactions,
      );
      if (attachInitialization) initialized = true;
      if (attachReactions) reacted = true;
      expanded.push(boundary);
    }
  }
  return Object.freeze(expanded);
}

export function defineResource(definition: ResourceDefinition): ResourceDefinition {
  if (typeof definition?.resource !== 'string' || definition.resource.trim() === '')
    throw definitionError('Resource.resource must be non-empty');
  if (typeof definition.schema !== 'string' || definition.schema.trim() === '')
    throw definitionError(`Resource "${definition.resource}" requires a non-empty schema`);
  if (!Array.isArray(definition.operations) || definition.operations.length === 0)
    throw definitionError(`Resource "${definition.resource}" requires operations`);
  if (!Array.isArray(definition.eventCatalog) || !Array.isArray(definition.reducers))
    throw definitionError(
      `Resource "${definition.resource}" requires eventCatalog and reducers arrays`,
    );
  return definition;
}

export type ResourceValue<Context, Value> = Value | ((input: Readonly<Context>) => Value);
