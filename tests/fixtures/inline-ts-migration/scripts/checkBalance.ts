import { Script, type ScriptContext } from '@potemkin/sdk';

@Script('checkBalance')
export class CheckBalance {
  run(ctx: ScriptContext): boolean {
    return ctx.state !== null && (ctx.state as Record<string, unknown>)['balance'] as number >= 0;
  }
}
