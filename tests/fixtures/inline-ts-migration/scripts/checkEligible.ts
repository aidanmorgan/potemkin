import { Script, type ScriptContext } from '@potemkin/sdk';

@Script('checkEligible')
export class CheckEligible {
  run(ctx: ScriptContext): boolean {
    const s = ctx.state as Record<string, unknown>;
    const p = ctx.command.payload as Record<string, unknown>;
    return s['tier'] === 'GOLD' && (s['balance'] as number) >= (p['amount'] as number);
  }
}
