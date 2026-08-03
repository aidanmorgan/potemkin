import type { OpenApiDoc } from "../contract/loader.js";
import { compileProgram } from "../authoring/runtimeModel.js";
import type { SimulationDefinition } from "../authoring/runtimeModel.js";
import { compileRuntime } from "../model/compiler.js";
import type { RuntimePolicies } from "../model/runtime.js";
import { mergeRuntimePolicies } from "../core/policyMerge.js";
import type { RuntimeModel } from "../model/index.js";
import type { RuntimeCompilationContext } from "../runtime/system.js";
import { compileYamlProgram } from "./public.js";
import type { YamlProgramInput } from "./public.js";

export interface MixedProgramInput {
  readonly yaml: YamlProgramInput;
  readonly direct: SimulationDefinition;
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

/** Compile YAML and TypeScript declarations into one canonical program. */
export async function compileMixedProgram(
  input: MixedProgramInput,
  context: RuntimeCompilationContext & { readonly openapi?: OpenApiDoc },
): Promise<RuntimeModel> {
  const yaml = await compileYamlProgram(input.yaml, {
    dependencies: context.dependencies,
    helpers: input.direct.helpers,
    allowExternalReferences: true,
  });
  const direct = compileProgram(input.direct, {
    dependencies: context.dependencies,
    openapi: context.openapi,
    allowExternalReferences: true,
  });
  return compileRuntime(
    {
      boundaries: [...yaml.boundaries, ...direct.boundaries],
      policies: mergePolicies(yaml.policies, direct.policies),
      helpers: direct.helpers,
    },
    context.dependencies,
  );
}
