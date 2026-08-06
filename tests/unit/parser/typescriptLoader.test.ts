import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { OpenApiDoc } from '../../../src/contract/loader';
import { loadTypeScriptConfiguration } from '../../../src/parser/typescriptLoader';
import { TypeScriptAuthoringError } from '../../../src/authoring/errors';
import { simulation } from '../../../src/authoring/builders';
import type { RegisteredFactory } from '../../../src/authoring/factory';
import { factoryName } from '../../../src/domain/references';

const openapi: OpenApiDoc = { raw: {}, paths: {} };

describe('configuration-driven TypeScript static factories', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-ts-authoring-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('loads a decorated static factory and honours include/exclude patterns', async () => {
    await fs.writeFile(
      path.join(root, 'model.ts'),
      `
      import { boundary, simulation } from "potemkin/sdk";
      import { PotemkinConfigure } from "potemkin/sdk";

      class Scenario {
        @PotemkinConfigure("widgets")
        static create() {
          return simulation().boundary(boundary("Widget", "/widgets").build()).build();
        }
      }
    `,
    );
    await fs.writeFile(
      path.join(root, 'ignored.test.ts'),
      `
      import { PotemkinConfigure } from "potemkin/sdk";
      class Ignored {
        @PotemkinConfigure("ignored")
        static create() { throw new Error("excluded factory was evaluated"); }
      }
    `,
    );

    const result = await loadTypeScriptConfiguration(
      { scan: [{ include: ['**/*.ts'], exclude: ['**/*.test.ts'] }] },
      root,
      {
        openapi,
        configuration: { version: 1, specmatic: 'specmatic.yaml', modules: ['yaml/**/*.yaml'] },
        sourceFiles: [],
      },
    );

    expect(result.files).toEqual([path.join(root, 'model.ts')]);
    expect(result.definition?.boundaries.map((item) => item.boundary)).toEqual(['Widget']);
  });

  it('composes decorated static factories from multiple selected files', async () => {
    await fs.writeFile(
      path.join(root, 'first.ts'),
      `
      import { boundary, simulation } from "potemkin/sdk";
      import { PotemkinConfigure } from "potemkin/sdk";
      class First {
        @PotemkinConfigure("first")
        static create() {
          return simulation().boundary(boundary("First", "/first").build()).build();
        }
      }
    `,
    );
    await fs.writeFile(
      path.join(root, 'second.ts'),
      `
      import { boundary, simulation } from "potemkin/sdk";
      import { PotemkinConfigure } from "potemkin/sdk";
      class Second {
        @PotemkinConfigure("second")
        static create() {
          return simulation().boundary(boundary("Second", "/second").build()).build();
        }
      }
    `,
    );

    const result = await loadTypeScriptConfiguration({ scan: [{ include: ['*.ts'] }] }, root, {
      openapi,
      configuration: { version: 1, specmatic: 'specmatic.yaml', modules: ['yaml/**/*.yaml'] },
      sourceFiles: [],
    });

    expect(result.definition?.boundaries.map((item) => item.boundary)).toEqual(['First', 'Second']);
  });

  it('does not treat an unannotated export as engine configuration', async () => {
    await fs.writeFile(
      path.join(root, 'unannotated-export.ts'),
      `
        export default {
          boundaries: [{ boundary: "Ignored", contractPath: "/ignored" }]
        };
      `,
    );

    const result = await loadTypeScriptConfiguration({ scan: [{ include: ['*.ts'] }] }, root, {
      openapi,
      configuration: { version: 1, specmatic: 'specmatic.yaml', modules: ['yaml/**/*.yaml'] },
      sourceFiles: [],
    });

    expect(result.definition).toBeUndefined();
  });

  it('normalizes supplied factories, composes optional definition sections, and preserves order', async () => {
    const calls: string[] = [];
    const factories: RegisteredFactory[] = [
      {
        name: factoryName('second'),
        source: 'class:Second.create',
        factory: async () => {
          calls.push('second');
          return simulation().build();
        },
      },
      {
        name: factoryName('first'),
        source: 'class:First.create',
        factory: () => ({ boundaries: [], resources: [], uses: [], helpers: [], policies: {} }),
      },
      {
        name: factoryName('ignored'),
        source: 'class:Ignored.create',
        factory: () => undefined as never,
      },
    ];

    const result = await loadTypeScriptConfiguration(
      { scan: [{ include: ['*.ts'] }] },
      root,
      {
        openapi,
        configuration: { version: 1, specmatic: 'specmatic.yaml', modules: [] },
        sourceFiles: [],
      },
      { factories },
    );

    expect(calls).toEqual(['second']);
    expect(result.definition).toMatchObject({
      boundaries: [],
      resources: [],
      uses: [],
      helpers: [],
      policies: {},
    });
  });

  it.each([
    ['boundaries', { boundaries: 'invalid', helpers: [] }],
    ['helpers', { boundaries: [], helpers: 'invalid' }],
  ] as const)('rejects a factory with invalid %s', async (_name, value) => {
    const factory: RegisteredFactory = {
      name: factoryName('invalid'),
      source: 'invalid.ts',
      factory: () => value as never,
    };

    await expect(
      loadTypeScriptConfiguration(
        { scan: [{ include: ['*.ts'] }] },
        root,
        {
          openapi,
          configuration: { version: 1, specmatic: 'specmatic.yaml', modules: [] },
          sourceFiles: [],
        },
        { factories: [factory] },
      ),
    ).rejects.toBeInstanceOf(TypeScriptAuthoringError);
  });

  it('wraps ordinary factory failures but preserves typed authoring failures', async () => {
    const ordinary: RegisteredFactory = {
      name: factoryName('ordinary'),
      source: 'ordinary.ts',
      factory: () => {
        throw new Error('factory exploded');
      },
    };
    await expect(
      loadTypeScriptConfiguration(
        { scan: [{ include: ['*.ts'] }] },
        root,
        {
          openapi,
          configuration: { version: 1, specmatic: 'specmatic.yaml', modules: [] },
          sourceFiles: [],
        },
        { factories: [ordinary] },
      ),
    ).rejects.toMatchObject({ code: 'TS_EXECUTION' });

    const typed: RegisteredFactory = {
      name: factoryName('typed'),
      source: 'typed.ts',
      factory: () => {
        throw new TypeScriptAuthoringError('TS_SOURCE_READ', 'already typed');
      },
    };
    await expect(
      loadTypeScriptConfiguration(
        { scan: [{ include: ['*.ts'] }] },
        root,
        {
          openapi,
          configuration: { version: 1, specmatic: 'specmatic.yaml', modules: [] },
          sourceFiles: [],
        },
        { factories: [typed] },
      ),
    ).rejects.toMatchObject({ code: 'TS_SOURCE_READ' });
  });
});
