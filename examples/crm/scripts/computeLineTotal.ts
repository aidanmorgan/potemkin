import { Script, type ScriptContext } from '@potemkin/sdk';

@Script('computeLineTotal')
export class ComputeLineTotal {
  run(ctx: ScriptContext): number {
    const qty = (ctx.command.payload['quantity'] as number) ?? 0;
    const price = (ctx.command.payload['unitPrice'] as number) ?? 0;
    return qty * price;
  }
}
