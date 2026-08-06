import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createDefaultTypeScriptModuleLoaderDependencies,
  TypeScriptModuleLoader,
} from '../../../src/parser/typescriptModuleLoader';
import { createTypeScriptSdk, sdk as productionSdk } from '../../../src/sdk';
import type { FactoryRegistrar } from '../../../src/authoring/factory';

describe('TypeScript module loader', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'potemkin-ts-module-loader-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('transpiles typed modules and resolves selected relative dependencies in process', async () => {
    await fs.writeFile(
      path.join(root, 'shared.ts'),
      `export const boundaryName: string = "ImportedBoundary";`,
    );
    const entry = path.join(root, 'entry.ts');
    await fs.writeFile(
      entry,
      `import { boundaryName } from "./shared";
       export const result: string = boundaryName;`,
    );

    const loader = new TypeScriptModuleLoader({
      cwd: root,
      scan: [{ include: ['**/*.ts'] }],
      sdk: productionSdk,
      dependencies: createDefaultTypeScriptModuleLoaderDependencies(),
    });

    expect(loader.load(entry).exports).toMatchObject({ result: 'ImportedBoundary' });
  });

  it('executes decorator syntax used by @PotemkinConfigure factories', async () => {
    const entry = path.join(root, 'scenario.ts');
    await fs.writeFile(
      entry,
      `import { PotemkinConfigure } from "potemkin/sdk";
       class Scenario {
         @PotemkinConfigure("scenario")
         static create(): { boundaries: never[] } { return { boundaries: [] }; }
       }`,
    );
    const registrations: string[] = [];
    const registrar: FactoryRegistrar = {
      register: ({ name }) => {
        registrations.push(name);
      },
      snapshot: () => [],
    };
    const sdk = createTypeScriptSdk(registrar);

    const loader = new TypeScriptModuleLoader({
      cwd: root,
      scan: [{ include: ['*.ts'] }],
      sdk,
      dependencies: createDefaultTypeScriptModuleLoaderDependencies(),
    });

    loader.load(entry);
    expect(registrations).toEqual(['scenario']);
  });

  it('reuses cached modules and records evaluated TSX files', async () => {
    const entry = path.join(root, 'entry.tsx');
    await fs.writeFile(entry, `export const result = "tsx";`);
    const loader = new TypeScriptModuleLoader({
      cwd: root,
      scan: [{ include: ['**/*'] }],
      sdk: productionSdk,
    });

    const first = loader.load(entry);
    expect(loader.load(entry)).toBe(first);
    expect(loader.loadedFiles()).toEqual([entry]);
  });

  it('rejects circular imports with a typed transpilation diagnostic', async () => {
    const entry = path.join(root, 'entry.ts');
    await fs.writeFile(entry, `import { value } from "./shared"; export { value };`);
    await fs.writeFile(
      path.join(root, 'shared.ts'),
      `import { value } from "./entry"; export { value };`,
    );
    const loader = new TypeScriptModuleLoader({
      cwd: root,
      scan: [{ include: ['**/*.ts'] }],
      sdk: productionSdk,
    });

    expect(() => loader.load(entry)).toThrow('Circular TypeScript import');
  });

  it('reports source, transpilation, and execution failures through typed errors', async () => {
    const entry = path.join(root, 'entry.ts');
    await fs.writeFile(entry, `export const value = 1;`);
    const defaults = createDefaultTypeScriptModuleLoaderDependencies();

    const readFailure = new TypeScriptModuleLoader({
      cwd: root,
      scan: [{ include: ['**/*.ts'] }],
      sdk: productionSdk,
      dependencies: {
        ...defaults,
        readFile: () => {
          throw new Error('read failed');
        },
      },
    });
    expect(() => readFailure.load(entry)).toThrow('Cannot read TypeScript authoring file');

    const transpileFailure = new TypeScriptModuleLoader({
      cwd: root,
      scan: [{ include: ['**/*.ts'] }],
      sdk: productionSdk,
      dependencies: {
        ...defaults,
        transpile: () => {
          throw new Error('transpile failed');
        },
      },
    });
    expect(() => transpileFailure.load(entry)).toThrow('TypeScript transpilation failed');

    const executionFailure = new TypeScriptModuleLoader({
      cwd: root,
      scan: [{ include: ['**/*.ts'] }],
      sdk: productionSdk,
      dependencies: {
        ...defaults,
        runInContext: () => {
          throw new Error('execution failed');
        },
      },
    });
    expect(() => executionFailure.load(entry)).toThrow('Top-level execution');
  });

  it.each(['fs', 'lodash'])('rejects forbidden import %s', async (specifier) => {
    const entry = path.join(root, `${specifier.replaceAll('/', '-')}.ts`);
    await fs.writeFile(entry, `import value from "${specifier}"; export { value };`);
    const loader = new TypeScriptModuleLoader({
      cwd: root,
      scan: [{ include: ['**/*.ts'] }],
      sdk: productionSdk,
    });

    expect(() => loader.load(entry)).toThrow(
      expect.objectContaining({ code: 'TS_IMPORT_FORBIDDEN' }),
    );
  });

  it('rejects missing and outside-scan relative imports', async () => {
    const missing = path.join(root, 'missing.ts');
    await fs.writeFile(missing, `import value from "./does-not-exist"; export { value };`);
    const loader = new TypeScriptModuleLoader({
      cwd: root,
      scan: [{ include: ['**/*.ts'] }],
      sdk: productionSdk,
    });
    expect(() => loader.load(missing)).toThrow(
      expect.objectContaining({ code: 'TS_IMPORT_OUTSIDE_SCAN' }),
    );

    const inside = path.join(root, 'inside');
    await fs.mkdir(inside);
    const outside = path.join(root, 'outside.ts');
    await fs.writeFile(outside, `export const value = 1;`);
    const restricted = path.join(inside, 'entry.ts');
    await fs.writeFile(restricted, `import { value } from "../outside"; export { value };`);
    const restrictedLoader = new TypeScriptModuleLoader({
      cwd: root,
      scan: [{ include: ['inside/**/*.ts'] }],
      sdk: productionSdk,
    });
    expect(() => restrictedLoader.load(restricted)).toThrow(
      expect.objectContaining({ code: 'TS_IMPORT_OUTSIDE_SCAN' }),
    );
  });

  it('rejects a path that exists but is not a file', async () => {
    const entry = path.join(root, 'entry.ts');
    await fs.writeFile(entry, `import value from "./shared"; export { value };`);
    const defaults = createDefaultTypeScriptModuleLoaderDependencies();
    const loader = new TypeScriptModuleLoader({
      cwd: root,
      scan: [{ include: ['**/*.ts'] }],
      sdk: productionSdk,
      dependencies: {
        ...defaults,
        exists: (file) => file === path.join(root, 'shared'),
        isFile: () => false,
      },
    });

    expect(() => loader.load(entry)).toThrow(
      expect.objectContaining({ code: 'TS_IMPORT_OUTSIDE_SCAN' }),
    );
  });
});
