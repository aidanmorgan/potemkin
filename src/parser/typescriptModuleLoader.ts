import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

import ts from 'typescript';

import {
  errorMessage,
  isTypeScriptAuthoringError,
  TypeScriptAuthoringError,
} from '../authoring/errors.js';
import type { ScanEntry } from '../contracts/config.js';
import { isTypeScriptSdkSpecifier, type TypeScriptSdk } from '../sdk/index.js';

export interface TypeScriptModuleRecord {
  readonly exports: Record<string, unknown>;
}

export interface TypeScriptModuleLoaderOptions {
  readonly cwd: string;
  readonly scan: readonly ScanEntry[];
  readonly sdk: TypeScriptSdk;
  readonly dependencies?: TypeScriptModuleLoaderDependencies;
}

/** Platform effects used by the TypeScript module loader. */
export interface TypeScriptModuleLoaderDependencies {
  readonly readFile: (file: string, encoding: 'utf8') => string;
  readonly exists: (file: string) => boolean;
  readonly isFile: (file: string) => boolean;
  readonly transpile: (source: string, file: string) => string;
  readonly createContext: (globals: Record<string, unknown>) => vm.Context;
  readonly runInContext: (code: string, context: vm.Context, file: string) => void;
}

/** Default production ports; hosts and tests may supply every port explicitly. */
export function createDefaultTypeScriptModuleLoaderDependencies(): TypeScriptModuleLoaderDependencies {
  return {
    readFile: (file, encoding) => fs.readFileSync(file, encoding),
    exists: (file) => fs.existsSync(file),
    isFile: (file) => fs.statSync(file).isFile(),
    transpile: (source, file) =>
      ts.transpileModule(source, {
        fileName: file,
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          experimentalDecorators: true,
          jsx: file.endsWith('.tsx') ? ts.JsxEmit.ReactJSX : undefined,
        },
      }).outputText,
    createContext: (globals) => vm.createContext(globals),
    runInContext: (code, context, file) => {
      vm.runInContext(code, context, { filename: file });
    },
  };
}

const FORBIDDEN_BUILTINS: ReadonlySet<string> = new Set([
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'net',
  'node:net',
  'http',
  'node:http',
  'https',
  'node:https',
  'child_process',
  'node:child_process',
  'os',
  'node:os',
  'process',
  'node:process',
]);

/** Loads one configured TypeScript module graph with injected SDK services. */
export class TypeScriptModuleLoader {
  private readonly modules = new Map<string, TypeScriptModuleRecord>();
  private readonly dependencies: TypeScriptModuleLoaderDependencies;

  constructor(private readonly options: TypeScriptModuleLoaderOptions) {
    this.dependencies = options.dependencies ?? createDefaultTypeScriptModuleLoaderDependencies();
  }

  /** Absolute files evaluated by this loader, including imported dependencies. */
  loadedFiles(): readonly string[] {
    return [...this.modules.keys()].sort();
  }

  load(absPath: string, inProgress: Set<string> = new Set()): TypeScriptModuleRecord {
    const cached = this.modules.get(absPath);
    if (cached !== undefined) return cached;
    if (inProgress.has(absPath)) {
      throw new TypeScriptAuthoringError('TS_TRANSPILE', `Circular TypeScript import: ${absPath}`, {
        details: { path: absPath },
        source: absPath,
      });
    }
    inProgress.add(absPath);
    try {
      const source = this.readSource(absPath);
      const transpiled = this.transpile(source, absPath);
      const module: TypeScriptModuleRecord = { exports: {} };
      const requireFn = (specifier: string): unknown =>
        this.resolveImport(specifier, absPath, inProgress);
      const wrapper = `(function(module, exports, require, __filename, __dirname){\n${transpiled}\n})(module, module.exports, require, __filename, __dirname);`;
      const sandbox = this.dependencies.createContext({
        module,
        require: requireFn,
        __filename: absPath,
        __dirname: path.dirname(absPath),
        console: silentConsole(),
        JSON,
        Math,
        Date,
        URL,
        Object,
        Array,
        Error,
        TypeError,
        RangeError,
        String,
        Number,
        Boolean,
        Symbol,
        RegExp,
        Map,
        Set,
        Promise,
      });

      try {
        this.dependencies.runInContext(wrapper, sandbox, absPath);
      } catch (error) {
        if (isTypeScriptAuthoringError(error)) throw error;
        throw new TypeScriptAuthoringError(
          'TS_EXECUTION',
          `Top-level execution of ${absPath} failed: ${errorMessage(error)}`,
          {
            details: { path: absPath, message: errorMessage(error) },
            source: absPath,
            cause: error,
          },
        );
      }
      this.modules.set(absPath, module);
      return module;
    } finally {
      inProgress.delete(absPath);
    }
  }

  private readSource(absPath: string): string {
    try {
      return this.dependencies.readFile(absPath, 'utf8');
    } catch (error) {
      throw new TypeScriptAuthoringError(
        'TS_SOURCE_READ',
        `Cannot read TypeScript authoring file ${absPath}: ${errorMessage(error)}`,
        { details: { path: absPath }, source: absPath, cause: error },
      );
    }
  }

  private transpile(source: string, absPath: string): string {
    try {
      return this.dependencies.transpile(source, absPath);
    } catch (error) {
      throw new TypeScriptAuthoringError(
        'TS_TRANSPILE',
        `TypeScript transpilation failed for ${absPath}: ${errorMessage(error)}`,
        {
          details: { path: absPath, message: errorMessage(error) },
          source: absPath,
          cause: error,
        },
      );
    }
  }

  private resolveImport(specifier: string, fromFile: string, inProgress: Set<string>): unknown {
    if (isTypeScriptSdkSpecifier(specifier)) return this.options.sdk;
    if (FORBIDDEN_BUILTINS.has(specifier)) {
      throw new TypeScriptAuthoringError(
        'TS_IMPORT_FORBIDDEN',
        `Forbidden import "${specifier}" in ${fromFile}`,
        { details: { specifier, from: fromFile }, source: fromFile },
      );
    }
    if (!specifier.startsWith('.')) {
      throw new TypeScriptAuthoringError(
        'TS_IMPORT_FORBIDDEN',
        `Non-relative imports are forbidden in TypeScript authoring files: "${specifier}"`,
        { details: { specifier, from: fromFile }, source: fromFile },
      );
    }
    const candidate = this.resolveSibling(path.resolve(path.dirname(fromFile), specifier));
    if (
      candidate === undefined ||
      !isInsideAnyScanDir(candidate, this.options.cwd, this.options.scan)
    ) {
      throw new TypeScriptAuthoringError(
        'TS_IMPORT_OUTSIDE_SCAN',
        `Import "${specifier}" from ${fromFile} is outside the configured typescript.scan roots`,
        {
          details: {
            specifier,
            from: fromFile,
            candidate: candidate ?? '',
            cwd: this.options.cwd,
          },
          source: fromFile,
        },
      );
    }
    return this.load(candidate, inProgress).exports;
  }

  private resolveSibling(candidate: string): string | undefined {
    if (this.dependencies.exists(candidate) && this.dependencies.isFile(candidate))
      return candidate;
    for (const extension of ['.ts', '.tsx', '.js', '/index.ts', '/index.tsx', '/index.js']) {
      const resolved = candidate + extension;
      if (this.dependencies.exists(resolved) && this.dependencies.isFile(resolved)) return resolved;
    }
    return undefined;
  }
}

function isInsideAnyScanDir(resolved: string, cwd: string, scan: readonly ScanEntry[]): boolean {
  for (const entry of scan) {
    for (const include of entry.include) {
      const root = path.resolve(cwd, stripGlobTail(include));
      const relative = path.relative(root, resolved);
      if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
        return true;
      }
    }
  }
  return false;
}

function stripGlobTail(pattern: string): string {
  const wildcard = pattern.search(/[*?[{]/);
  const head = wildcard < 0 ? pattern : pattern.slice(0, wildcard);
  return head.endsWith(path.sep) ? head.slice(0, -1) : head;
}

function silentConsole(): Console {
  const swallow = (..._args: unknown[]): void => {
    /* trusted authoring modules stay quiet during discovery */
  };
  return {
    log: swallow,
    info: swallow,
    warn: swallow,
    error: swallow,
    debug: swallow,
    trace: swallow,
  } as unknown as Console;
}
