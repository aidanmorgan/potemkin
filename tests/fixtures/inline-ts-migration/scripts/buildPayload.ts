import { Script, type ScriptContext } from '@potemkin/sdk';

@Script('buildPayload')
export class BuildPayload {
  run(ctx: ScriptContext): string {
    return 'tier:' + ((ctx.state as Record<string, unknown>)['tier'] as string);
  }
}
