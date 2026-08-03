import {
  PotemkinConfigure,
  defineHelper,
  helperName,
  simulation,
  type FactoryContext,
} from "potemkin/sdk";

const parityName = defineHelper(helperName("parityName"), (value: string): string => value);

export class AuthoringParityHelperFactory {
  @PotemkinConfigure("authoring-parity-helper")
  static create(_context: FactoryContext) {
    return simulation().helper(parityName).build();
  }
}
