import {
  PotemkinConfigure,
  defineHelper,
  factoryName,
  helperName,
  simulation,
  type FactoryContext,
} from "potemkin/sdk";

const parityName = defineHelper(helperName("parityName"), (value: string): string => value);

export class AuthoringParityHelperFactory {
  @PotemkinConfigure(factoryName("authoring-parity-helper"))
  static create(_context: FactoryContext) {
    return simulation().helper(parityName).build();
  }
}
