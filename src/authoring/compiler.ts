/** Compiler adapter from the TypeScript authoring descriptor to RuntimeProgram. */

import { compileRuntime } from '../model/compiler.js';
import type { RuntimeDefinition, RuntimeModel } from '../model/index.js';
import type { RuntimeBoundary, RuntimeDependencies } from '../model/runtime.js';
import { definitionError } from './errors.js';
import { expandResources } from './resourceModel.js';
import { composeBoundaries } from './composition.js';
import type { OpenApiDocumentDescriptor } from '../contracts/openapi.js';
import type { JsonObject, JsonValue } from '../contracts/value.js';
import type { BoundaryDefinition, SimulationDefinition } from './types.js';
import { isYamlComponentReference } from './composition.js';
import type {
  ComponentDefinition,
  ComponentInclude,
  YamlComponentReference,
  UseDefinition,
} from './types.js';

export interface ExternalComponentUse {
  readonly reference: YamlComponentReference;
  readonly as: string;
  readonly contractPath: string;
}

export interface AuthoringCompilation {
  readonly definition: RuntimeDefinition;
  readonly externalUses: readonly ExternalComponentUse[];
  readonly externalIncludes: ReadonlyMap<string, readonly YamlComponentReference[]>;
}

export function compileProgram(
  definition: SimulationDefinition,
  options: Readonly<{
    dependencies: RuntimeDependencies;
    openapi?: OpenApiDocumentDescriptor;
  }>,
): RuntimeModel {
  return compileRuntime(compileAuthoringDefinition(definition, options), options.dependencies);
}

/** Lower TypeScript authoring once into the source-neutral compiler input. */
export function compileAuthoringDefinition(
  definition: SimulationDefinition,
  options: Readonly<{ openapi?: OpenApiDocumentDescriptor }>,
): RuntimeDefinition {
  return compileAuthoringComposition(definition, options).definition;
}

/** Lower authoring while retaining explicit cross-language composition edges. */
export function compileAuthoringComposition(
  definition: SimulationDefinition,
  options: Readonly<{ openapi?: OpenApiDocumentDescriptor }>,
): AuthoringCompilation {
  if (!definition || !Array.isArray(definition.boundaries))
    throw definitionError('A simulation requires a boundaries array');
  const externalUses: ExternalComponentUse[] = [];
  const externalIncludes = new Map<string, readonly YamlComponentReference[]>();
  for (const boundary of definition.boundaries) {
    const references = collectExternalIncludes(boundary.include ?? []);
    if (references.length > 0) externalIncludes.set(boundary.boundary, references);
  }
  const directUses = (definition.uses ?? []).filter((value): value is UseDefinition => {
    if (!isYamlComponentReference(value.component)) {
      const references = collectExternalIncludesFromComponent(
        value.component,
        value.parameters ?? {},
      );
      if (references.length > 0) externalIncludes.set(value.as, references);
      return true;
    }
    externalUses.push({
      reference: value.component,
      as: value.as,
      contractPath: value.contractPath,
    });
    return false;
  });
  const composed = composeBoundaries(
    [...definition.boundaries, ...expandResources(definition.resources ?? [], options.openapi)],
    directUses,
  );
  return {
    definition: {
      boundaries: composed.map(toRuntimeBoundary),
      policies: definition.policies,
      helpers: definition.helpers,
    },
    externalUses,
    externalIncludes,
  };
}

function collectExternalIncludes(includes: readonly ComponentInclude[]): YamlComponentReference[] {
  const result: YamlComponentReference[] = [];
  const visit = (values: readonly ComponentInclude[], stack: readonly string[]): void => {
    for (const entry of values) {
      if (isYamlComponentReference(entry.component)) {
        result.push(entry.component);
        continue;
      }
      if (stack.includes(entry.component.name))
        throw definitionError(
          `Cyclic TypeScript component composition: ${[...stack, entry.component.name].join(' -> ')}`,
        );
      visit(entry.component.instantiate(entry.parameters ?? {}).include ?? [], [
        ...stack,
        entry.component.name,
      ]);
    }
  };
  visit(includes, []);
  return result;
}

function collectExternalIncludesFromComponent(
  component: ComponentDefinition,
  parameters: Readonly<JsonObject>,
): YamlComponentReference[] {
  return collectExternalIncludes(component.instantiate(parameters).include ?? []);
}

/** Translate authoring query values into executable runtime callbacks at the compiler seam. */
function toRuntimeBoundary(boundary: BoundaryDefinition): RuntimeBoundary {
  const { include: _include, export: exportConfig, query, ...withoutComposition } = boundary;
  if (query === undefined) {
    return {
      ...withoutComposition,
      ...(exportConfig === undefined ? {} : { export: exportConfig }),
    };
  }
  const fallback = query.fallback;
  const { fallback: _fallback, ...withoutFallback } = query;
  return {
    ...withoutComposition,
    ...(exportConfig === undefined ? {} : { export: exportConfig }),
    query: {
      ...withoutFallback,
      ...(fallback === undefined
        ? {}
        : {
            fallback:
              typeof fallback === 'function'
                ? fallback
                : (_context: Readonly<unknown>) => fallback as JsonValue | undefined,
          }),
    } satisfies RuntimeBoundary['query'],
  };
}
