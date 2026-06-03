import { Script, type ScriptContext } from '@potemkin/sdk';

@Script('checkActive')
export class CheckActive {
  run(ctx: ScriptContext): boolean {
    return (ctx.state as Record<string, unknown>)['status'] === 'ACTIVE';
  }
}
