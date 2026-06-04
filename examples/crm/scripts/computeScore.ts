import { Script, type ScriptContext } from '@potemkin/sdk';

@Script('computeScore')
export class ComputeScore {
  run(ctx: ScriptContext): number {
    const source = ctx.command.payload['source'] as string;
    const baseScore: Record<string, number> = { REFERRAL: 80, PARTNER: 70, WEBSITE: 50, COLD_LIST: 20 };
    return baseScore[source] ?? 30;
  }
}
