import { Script, type ScriptContext } from '@potemkin/sdk';

@Script('checkRiskBand')
export class CheckRiskBand {
  run(ctx: ScriptContext): boolean {
    return (ctx.state as Record<string, unknown>)['balance'] as number > 100;
  }
}
