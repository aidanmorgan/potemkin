import * as path from 'node:path';

import { TypeScriptAuthoringError } from '../../../src/authoring/errors.js';
import { hasPotemkinConfigureDecorator } from '../../../src/parser/typescriptFactorySyntax.js';
import { isDecoratedTypeScriptModule } from '../../../src/parser/typescriptDiscovery.js';

describe('TypeScript factory syntax discovery', () => {
  it('recognizes only a static method decorated with the imported factory decorator', () => {
    expect(
      hasPotemkinConfigureDecorator(
        `
          import { PotemkinConfigure } from "potemkin/sdk";
          class Scenario {
            @PotemkinConfigure("scenario")
            static create() { return { boundaries: [] }; }
          }
        `,
        'scenario.ts',
      ),
    ).toBe(true);
  });

  it('does not match comments, strings, instance methods, or aliased decorators', () => {
    expect(
      hasPotemkinConfigureDecorator(
        `
          import { PotemkinConfigure as Configure } from "potemkin/sdk";
          // @PotemkinConfigure("comment")
          const text = "@PotemkinConfigure('string')";
          class Scenario {
            @Configure("scenario")
            create() { return { boundaries: [] }; }
          }
        `,
        'scenario.ts',
      ),
    ).toBe(false);
  });

  it('reports source inspection failures through the typed diagnostic contract', () => {
    const missingFile = path.join(
      '/tmp',
      `potemkin-missing-authoring-${process.pid}-${Date.now()}.ts`,
    );

    let failure: unknown;
    try {
      isDecoratedTypeScriptModule(missingFile);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(TypeScriptAuthoringError);
    expect(failure).toMatchObject({
      code: 'TS_SOURCE_READ',
      location: { source: missingFile },
    });
  });
});
