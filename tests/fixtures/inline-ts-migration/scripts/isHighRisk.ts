import { Script, type ScriptContext } from '@potemkin/sdk';

@Script('isHighRisk')
export class IsHighRisk {
  run(ctx: ScriptContext): boolean {
    return ((ctx.state as Record<string, unknown>)['riskScore'] as number) > 80;
  }
}
