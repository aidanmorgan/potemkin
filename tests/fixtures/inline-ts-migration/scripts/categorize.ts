import { Script, type ScriptContext } from '@potemkin/sdk';

function getBand(score: number): string {
  if (score >= 8) return 'HIGH';
  if (score >= 5) return 'MED';
  return 'LOW';
}

@Script('categorize')
export class Categorize {
  run(ctx: ScriptContext): string {
    return getBand((ctx.state as Record<string, unknown>)['score'] as number);
  }
}
