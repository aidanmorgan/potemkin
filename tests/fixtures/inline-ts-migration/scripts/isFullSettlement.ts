import { Script, type ScriptContext } from '@potemkin/sdk';

@Script('isFullSettlement')
export class IsFullSettlement {
  run(ctx: ScriptContext): boolean {
    const p = ctx.command.payload as Record<string, unknown>;
    const s = ctx.state as Record<string, unknown>;
    return (p['amount'] as number) >= (s['balance'] as number);
  }
}
