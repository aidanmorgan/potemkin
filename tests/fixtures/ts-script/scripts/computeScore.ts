import { Script, type ScriptContext } from '@potemkin/sdk';

@Script('computeScore')
export class ComputeScore {
  run(ctx: ScriptContext): number {
    const base: Record<string, number> = { REFERRAL: 80, WEBSITE: 50, PARTNER: 70, COLD_LIST: 20 };
    return base[ctx.command.payload['source'] as string] ?? 30;
  }
}
