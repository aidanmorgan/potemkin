import * as yaml from 'js-yaml';
import type { OpenApiDoc } from '../contract/loader.js';
import { compileAuthoringComposition, type AuthoringCompilation } from '../authoring/compiler.js';
import { use } from '../authoring/composition.js';
import type {
  ComponentDefinition,
  ComponentInclude,
  SimulationDefinition,
  YamlComponentReference,
} from '../authoring/types.js';
import { definitionError } from '../authoring/errors.js';
import { boundaryName, parseContractPath } from '../domain/references.js';
import { compileRuntime } from '../model/compiler.js';
import type { RuntimeDefinition } from '../model/index.js';
import type { RuntimeBoundary, RuntimePolicies } from '../model/runtime.js';
import { mergeRuntimePolicies } from '../core/policyMerge.js';
import type { RuntimeModel } from '../model/index.js';
import type { RuntimeCompilationContext } from '../runtime/system.js';
import { compileYamlDefinition } from './public.js';
import { parseUseMapping } from './yamlParser.js';
import type { YamlModule, YamlProgramInput } from './public.js';

export interface MixedProgramInput {
  readonly yaml: YamlProgramInput;
  readonly direct: SimulationDefinition;
}

interface ExternalYamlInclude {
  readonly boundary: string;
  readonly component: ComponentDefinition;
}

function mergePolicies(left: RuntimePolicies, right: RuntimePolicies): RuntimePolicies {
  const merged = mergeRuntimePolicies([left, right]);
  return {
    ...merged,
    ...left,
    ...right,
    idempotency: right.idempotency ?? left.idempotency,
    auth: right.auth ?? left.auth,
    securityHeaders: right.securityHeaders ?? left.securityHeaders,
    hateoas: right.hateoas ?? left.hateoas,
    versioning: right.versioning ?? left.versioning,
    fallback: right.fallback ?? left.fallback,
    coverage: merged.coverage,
    lifecycle: right.lifecycle ?? left.lifecycle,
    faults: merged.faults,
    reactions: merged.reactions,
    sagas: merged.sagas,
    derivedProjections: merged.derivedProjections,
    webhooks: merged.webhooks,
  };
}

export function collectTypeScriptComponents(
  definition: SimulationDefinition,
): ReadonlyMap<string, ComponentDefinition> {
  const components = new Map<string, ComponentDefinition>();
  const visitIncludes = (includes: readonly ComponentInclude[], stack: readonly string[]): void => {
    for (const entry of includes) {
      if ('kind' in entry.component) continue;
      if (stack.includes(entry.component.name))
        throw definitionError(
          `Cyclic TypeScript component composition: ${[...stack, entry.component.name].join(' -> ')}`,
        );
      if (components.has(entry.component.name)) continue;
      components.set(entry.component.name, entry.component);
      visitIncludes(entry.component.instantiate(entry.parameters ?? {}).include ?? [], [
        ...stack,
        entry.component.name,
      ]);
    }
  };
  for (const component of definition.components ?? []) {
    if (components.has(component.name))
      throw definitionError(`Duplicate TypeScript component "${component.name}"`);
    components.set(component.name, component);
    visitIncludes(component.instantiate({}).include ?? [], [component.name]);
  }
  visitIncludes(
    definition.boundaries.flatMap((boundary) => boundary.include ?? []),
    [],
  );
  for (const entry of definition.uses ?? []) {
    if ('kind' in entry.component) continue;
    if (!components.has(entry.component.name))
      components.set(entry.component.name, entry.component);
    visitIncludes(entry.component.instantiate(entry.parameters ?? {}).include ?? [], [
      entry.component.name,
    ]);
  }
  return components;
}

export function prepareMixedYaml(
  input: YamlProgramInput,
  typescriptComponents: ReadonlyMap<string, ComponentDefinition>,
): {
  readonly input: YamlProgramInput;
  readonly uses: readonly {
    component: ComponentDefinition;
    as: string;
    contractPath: string;
    with?: Record<string, string | number | boolean>;
    bind?: Record<string, string>;
  }[];
  readonly includes: readonly ExternalYamlInclude[];
} {
  if (typescriptComponents.size === 0) return { input, uses: [], includes: [] };
  const boundaryModules: YamlModule[] = [];
  const includes: ExternalYamlInclude[] = [];
  for (const module of input.modules) {
    const raw = yaml.load(module.yaml);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      boundaryModules.push(module);
      continue;
    }
    const record = raw as Record<string, unknown>;
    const boundary = typeof record['boundary'] === 'string' ? record['boundary'] : undefined;
    const rawIncludes = Array.isArray(record['include']) ? record['include'] : undefined;
    if (boundary === undefined || rawIncludes === undefined) {
      boundaryModules.push(module);
      continue;
    }
    const remaining: unknown[] = [];
    for (const value of rawIncludes) {
      const entry = value as Record<string, unknown>;
      const name = typeof entry['component'] === 'string' ? entry['component'] : undefined;
      const component = name === undefined ? undefined : typescriptComponents.get(name);
      if (component === undefined) remaining.push(value);
      else includes.push({ boundary, component });
    }
    boundaryModules.push(
      remaining.length === rawIncludes.length
        ? module
        : {
            name: module.name,
            yaml: yaml.dump({
              ...record,
              ...(remaining.length === 0 ? { include: undefined } : { include: remaining }),
            }),
          },
    );
  }
  const yamlUseModules: YamlModule[] = [];
  const directUses: {
    component: ComponentDefinition;
    as: string;
    contractPath: string;
    with?: Record<string, string | number | boolean>;
    bind?: Record<string, string>;
  }[] = [];
  if (input.useMappingModules === undefined)
    return { input: { ...input, modules: boundaryModules }, uses: [], includes };
  for (const module of input.useMappingModules) {
    const entries = parseUseMapping(module.yaml);
    const remaining = [];
    for (const entry of entries) {
      const component = typescriptComponents.get(entry.component);
      if (component === undefined) {
        remaining.push(entry);
      } else {
        directUses.push({
          component,
          as: entry.as,
          contractPath: entry.contractPath,
          ...(entry.with === undefined ? {} : { with: entry.with }),
          ...(entry.bind === undefined ? {} : { bind: entry.bind }),
        });
      }
    }
    if (remaining.length > 0)
      yamlUseModules.push({ name: module.name, yaml: yaml.dump({ use: remaining }) });
  }
  return {
    input: {
      ...input,
      modules: boundaryModules,
      ...(yamlUseModules.length === 0
        ? { useMappingModules: undefined }
        : { useMappingModules: yamlUseModules }),
    },
    uses: directUses,
    includes,
  };
}

function syntheticPath(name: string): string {
  return `/__potemkin_component/${encodeURIComponent(name)}`;
}

async function compileYamlComponent(
  reference: YamlComponentReference,
  input: YamlProgramInput,
  context: RuntimeCompilationContext & { readonly openapi?: OpenApiDoc },
): Promise<RuntimeBoundary> {
  const definition = await compileYamlDefinition(
    {
      modules: [],
      componentModules: input.componentModules,
      useMappingModules: [
        {
          name: `component:${reference.name}`,
          yaml: yaml.dump({
            use: [
              {
                component: reference.name,
                as: reference.name,
                contract_path: syntheticPath(reference.name),
              },
            ],
          }),
        },
      ],
    },
    { dependencies: context.dependencies },
  );
  const boundary = definition.boundaries[0];
  if (boundary === undefined)
    throw definitionError(`YAML component "${reference.name}" did not produce a runtime fragment`);
  return boundary;
}

async function compileTypeScriptComponent(
  component: ComponentDefinition,
  context: RuntimeCompilationContext & { readonly openapi?: OpenApiDoc },
): Promise<RuntimeBoundary> {
  const source = component.instantiate({});
  if ((source.include ?? []).some((entry) => 'kind' in entry.component))
    throw definitionError(
      `TypeScript component "${component.name}" contains an unresolved YAML component reference`,
    );
  const compilation = compileAuthoringComposition(
    {
      boundaries: [],
      uses: [
        use(
          component,
          boundaryName(component.name),
          parseContractPath(syntheticPath(component.name)),
        ),
      ],
    },
    { openapi: context.openapi },
  );
  if (compilation.externalUses.length > 0 || compilation.externalIncludes.size > 0)
    throw definitionError(
      `TypeScript component "${component.name}" contains an unresolved composition reference`,
    );
  const model = compileRuntime(compilation.definition, context.dependencies);
  const boundary = model.boundaries[0];
  if (boundary === undefined)
    throw definitionError(
      `TypeScript component "${component.name}" did not produce a runtime fragment`,
    );
  return boundary;
}

function renameBoundary(
  boundary: RuntimeBoundary,
  name: string,
  contractPath: string,
): RuntimeBoundary {
  const previous = boundary.boundary;
  const rename = (value: string): string => (value === previous ? name : value);
  return {
    ...boundary,
    boundary: name,
    contractPath,
    behaviors: boundary.behaviors.map((behavior) => ({
      ...behavior,
      ...(behavior.dispatchCommands === undefined
        ? {}
        : {
            dispatchCommands: behavior.dispatchCommands.map((command) => ({
              ...command,
              boundary: rename(command.boundary),
            })),
          }),
    })),
    reactions: boundary.reactions?.map((reaction) => ({
      ...reaction,
      boundary: rename(reaction.boundary),
    })),
  };
}

function mergeFragment(
  host: RuntimeBoundary,
  fragment: RuntimeBoundary,
  source: string,
): RuntimeBoundary {
  const localEvents = new Set(host.eventCatalog.map((event) => event.type));
  const localBehaviors = new Set(host.behaviors.map((behavior) => behavior.name));
  return {
    ...host,
    eventCatalog: [
      ...host.eventCatalog,
      ...fragment.eventCatalog.filter((event) => !localEvents.has(event.type)),
    ],
    behaviors: [
      ...host.behaviors,
      ...fragment.behaviors.filter((behavior) => !localBehaviors.has(behavior.name)),
    ],
    reducers: [...host.reducers, ...fragment.reducers],
    ...(fragment.identity === undefined
      ? {}
      : host.identity === undefined
        ? { identity: fragment.identity }
        : (() => {
            throw definitionError(
              `Cross-language component "${source}" conflicts with boundary "${host.boundary}" identity`,
            );
          })()),
    ...(fragment.schema === undefined
      ? {}
      : host.schema === undefined
        ? { schema: fragment.schema }
        : (() => {
            throw definitionError(
              `Cross-language component "${source}" conflicts with boundary "${host.boundary}" schema`,
            );
          })()),
  };
}

async function applyCrossLanguageComposition(
  yamlDefinition: RuntimeDefinition,
  directDefinition: RuntimeDefinition,
  compilation: AuthoringCompilation,
  yamlInput: YamlProgramInput,
  yamlIncludes: readonly ExternalYamlInclude[],
  context: RuntimeCompilationContext & { readonly openapi?: OpenApiDoc },
): Promise<{ readonly yaml: RuntimeDefinition; readonly direct: RuntimeDefinition }> {
  const yamlComponents = new Map<string, RuntimeBoundary>();
  const getYaml = async (reference: YamlComponentReference): Promise<RuntimeBoundary> => {
    const cached = yamlComponents.get(reference.name);
    if (cached !== undefined) return cached;
    const value = await compileYamlComponent(reference, yamlInput, context);
    yamlComponents.set(reference.name, value);
    return value;
  };
  const yamlBoundaries = [...yamlDefinition.boundaries];
  for (const externalInclude of yamlIncludes) {
    const index = yamlBoundaries.findIndex(
      (boundary) => boundary.boundary === externalInclude.boundary,
    );
    if (index < 0)
      throw definitionError(
        `Cross-language YAML include host "${externalInclude.boundary}" was not compiled`,
      );
    yamlBoundaries[index] = mergeFragment(
      yamlBoundaries[index]!,
      await compileTypeScriptComponent(externalInclude.component, context),
      externalInclude.component.name,
    );
  }
  const directBoundaries = [...directDefinition.boundaries];
  for (const externalUse of compilation.externalUses) {
    const fragment = await getYaml(externalUse.reference);
    directBoundaries.push(renameBoundary(fragment, externalUse.as, externalUse.contractPath));
  }
  for (const [boundaryNameValue, references] of compilation.externalIncludes) {
    const index = directBoundaries.findIndex((boundary) => boundary.boundary === boundaryNameValue);
    if (index < 0)
      throw definitionError(`Cross-language include host "${boundaryNameValue}" was not compiled`);
    let host = directBoundaries[index]!;
    for (const reference of references)
      host = mergeFragment(host, await getYaml(reference), reference.name);
    directBoundaries[index] = host;
  }
  return {
    yaml: { ...yamlDefinition, boundaries: yamlBoundaries },
    direct: { ...directDefinition, boundaries: directBoundaries },
  };
}

/** Compile YAML and TypeScript declarations into one canonical program. */
export async function compileMixedProgram(
  input: MixedProgramInput,
  context: RuntimeCompilationContext & { readonly openapi?: OpenApiDoc },
): Promise<RuntimeModel> {
  const typescriptComponents = collectTypeScriptComponents(input.direct);
  const prepared = prepareMixedYaml(input.yaml, typescriptComponents);
  const direct: SimulationDefinition = {
    ...input.direct,
    uses: [
      ...(input.direct.uses ?? []),
      ...prepared.uses.map((entry) =>
        use(
          entry.component,
          boundaryName(entry.as),
          parseContractPath(entry.contractPath),
          entry.with,
          entry.bind,
        ),
      ),
    ],
  };
  const yamlDefinition = await compileYamlDefinition(prepared.input, {
    dependencies: context.dependencies,
    helpers: direct.helpers,
  });
  const directCompilation = compileAuthoringComposition(direct, { openapi: context.openapi });
  const directDefinition = directCompilation.definition;
  const composed = await applyCrossLanguageComposition(
    yamlDefinition,
    directDefinition,
    directCompilation,
    prepared.input,
    prepared.includes,
    context,
  );
  return compileRuntime(
    {
      boundaries: [...composed.yaml.boundaries, ...composed.direct.boundaries],
      policies: mergePolicies(composed.yaml.policies ?? {}, composed.direct.policies ?? {}),
      helpers: direct.helpers,
    },
    context.dependencies,
  );
}
