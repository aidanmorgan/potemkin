import type { RuntimeSystem } from "../runtime/system.js";
import type { RuntimeBootInput } from "../runtime/system.js";
import { bootConfiguredRuntimeFromConfig } from "./configured.js";
import type { OpenApiLoadObservability } from "../contract/loader.js";
import type { YamlCompilationObservability } from "./yamlParser.js";

/** File-system boot input for a YAML configuration. */
export interface YamlFileBootInput extends Omit<
  RuntimeBootInput,
  "program" | "definition" | "programFactory"
> {
  readonly potemkinConfigPath: string;
  readonly onConfigurationError?: (error: unknown) => void;
  readonly authoringObservability?: OpenApiLoadObservability & YamlCompilationObservability;
}

/** Load the YAML configuration, discover TypeScript reducers, and boot it. */
export async function bootYamlRuntimeFromConfig(input: YamlFileBootInput): Promise<RuntimeSystem> {
  return bootConfiguredRuntimeFromConfig(input);
}
