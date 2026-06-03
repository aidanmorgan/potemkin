import { Script, type ScriptContext } from '@potemkin/sdk';

@Script('computeLabel')
export class ComputeLabel {
  run(ctx: ScriptContext): string {
    const s = ctx.state as Record<string, unknown>;
    const p = ctx.command.payload as Record<string, unknown>;
    return (s['tier'] as string) + '-' + String(p['amount']);
  }
}
