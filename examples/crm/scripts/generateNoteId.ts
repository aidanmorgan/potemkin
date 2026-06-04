import { Script, type ScriptContext } from '@potemkin/sdk';

@Script('generateNoteId')
export class GenerateNoteId {
  run(ctx: ScriptContext): string {
    return ctx.helpers.uuid();
  }
}
