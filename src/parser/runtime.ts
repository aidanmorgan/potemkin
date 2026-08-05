import { bootRuntime, type RuntimeBootInput, type RuntimeSystem } from '../runtime/system.js';
import { compileYamlProgram, type YamlProgramInput } from './public.js';

/** Runtime boot input for a YAML-authored program. */
export interface YamlRuntimeBootInput extends Omit<
  RuntimeBootInput,
  'program' | 'definition' | 'programFactory'
> {
  readonly yamlProgram: YamlProgramInput;
}

/** Compile YAML through the parser and boot the source-independent runtime. */
export async function bootYamlRuntime(input: YamlRuntimeBootInput): Promise<RuntimeSystem> {
  const { yamlProgram, ...runtimeInput } = input;
  const system = await bootRuntime({
    ...runtimeInput,
    programFactory: ({ dependencies }) => compileYamlProgram(yamlProgram, { dependencies }),
  });
  return system;
}
