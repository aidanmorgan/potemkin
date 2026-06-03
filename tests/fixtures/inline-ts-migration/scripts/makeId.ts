import { Script, type ScriptContext } from '@potemkin/sdk';

@Script('makeId')
export class MakeId {
  run(ctx: ScriptContext): string {
    return ctx.helpers.uuid();
  }
}
