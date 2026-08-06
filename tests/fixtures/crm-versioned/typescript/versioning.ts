import { PotemkinConfigure, defineGlobal, factoryName, simulation } from 'potemkin/sdk';

export class TypeScriptVersioningFactory {
  @PotemkinConfigure(factoryName('crm-versioning-typescript'))
  static create() {
    return simulation()
      .global(
        defineGlobal({
          versioning: {
            enabled: true,
            versions: [
              { version: 'v1', prefix: '/v1' },
              { version: 'v2', prefix: '/v2', default: true },
            ],
          },
        }),
      )
      .build();
  }
}
