import type { RuntimeDependencies, RuntimeHelperDefinition } from "../model/runtime.js";
import type { RuntimeModel } from "../model/index.js";
import { compileYaml as linkYaml } from "./yamlParser.js";
import { compileYamlModel } from "./yamlCompiler.js";
import type { YamlCompilationObservability } from "./yamlParser.js";

/** YAML source files that make up one parser compilation unit. */
export interface YamlModule {
  readonly name: string;
  readonly yaml: string;
}

/** Input accepted by the YAML parser/compiler. */
export interface YamlProgramInput {
  readonly modules: readonly YamlModule[];
  readonly globalYaml?: string;
  readonly componentModules?: readonly YamlModule[];
  readonly useMappingModules?: readonly YamlModule[];
}

/** Runtime services supplied by the host while YAML is being compiled. */
export interface YamlCompilerOptions {
  readonly dependencies: RuntimeDependencies;
  readonly observability?: YamlCompilationObservability;
  /** TypeScript helpers registered by factories and exposed to YAML CEL. */
  readonly helpers?: readonly RuntimeHelperDefinition[];
  /** Used only while composing YAML with another authoring source. */
  readonly allowExternalReferences?: boolean;
}

/**
 * Parse and compile YAML into the canonical runtime program consumed by the
 * TypeScript engine. CEL and the YAML-linked model stop at this boundary.
 */
export async function compileYamlProgram(
  input: YamlProgramInput,
  options: YamlCompilerOptions,
): Promise<RuntimeModel> {
  const linked = await linkYaml(
    input.modules,
    input.globalYaml,
    input.componentModules,
    input.useMappingModules,
    options.observability,
  );
  return compileYamlModel(linked, {
    ...options,
    logger: options.observability?.logger,
  });
}
