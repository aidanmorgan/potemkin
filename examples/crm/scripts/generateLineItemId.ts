import { Script, type ScriptContext } from '@potemkin/sdk';

@Script('generateLineItemId')
export class GenerateLineItemId {
  run(ctx: ScriptContext): string {
    return ctx.helpers.uuid();
  }
}
