import { Script, type ScriptContext } from '@potemkin/sdk';

@Script('getBalance')
export class GetBalance {
  run(ctx: ScriptContext): number {
    return (ctx.state as Record<string, unknown>)['balance'] as number;
  }
}
