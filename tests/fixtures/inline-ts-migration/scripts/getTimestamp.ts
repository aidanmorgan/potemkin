import { Script, type ScriptContext } from '@potemkin/sdk';

@Script('getTimestamp')
export class GetTimestamp {
  run(ctx: ScriptContext): string {
    return ctx.helpers.now();
  }
}
