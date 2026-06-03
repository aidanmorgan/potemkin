import { Script, type ScriptContext } from '@potemkin/sdk';

@Script('computeSequenceNum')
export class ComputeSequenceNum {
  run(ctx: ScriptContext): number {
    const existing = (ctx.state?.['transcript'] as unknown[]) ?? [];
    return existing.length + 1;
  }
}
