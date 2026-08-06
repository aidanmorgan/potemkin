import { PotemkinConfigure, defineGlobal, factoryName, simulation } from 'potemkin/sdk';

export class TypeScriptControlDefaultsFactory {
  @PotemkinConfigure(factoryName('typescript-control-defaults'))
  static create() {
    return simulation()
      .global(defineGlobal({ controlDefaults: { transparency: { dryRun: true } } }))
      .build();
  }
}
