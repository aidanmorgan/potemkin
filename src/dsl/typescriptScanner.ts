import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

import { glob } from 'tinyglobby';
import * as esbuild from 'esbuild';

import { BootError } from '../errors.js';
import { registry as sdkRegistry, scriptRegistry as sdkScriptRegistry, type RegisteredReducer, type RegisteredScript } from '../sdk/index.js';

// Scans typescript.scan[].include/exclude, transpiles each .ts via esbuild,
// loads each module into a node:vm context whose require() resolves only
// `@potemkin/sdk` and sibling .ts files inside the same include directory.
// Returns the registered reducers drained from the SDK registry.
//
// TRUST MODEL — read before modifying the vm context or adding imports.
//
// Scanned @Script and @Reducer files execute as TRUSTED host code. The vm
// context is NOT a security boundary and must not be treated as one. The
// static checks (FORBIDDEN_BUILTINS, ENV_WRITE_PATTERNS) guard against
// accidental mistakes — a developer stray import or an inadvertent
// process.env write — not against a malicious or untrusted .ts file.
//
// In particular: `Object.constructor('return process')()` or similar
// prototype-chain walks CAN reach the host process from inside the vm context
// because the vm shares the host's JavaScript heap. The node:vm isolation is
// convenience isolation, not a security sandbox.
//
// Only load .ts files that are version-controlled in the same repository as
// the rest of the simulation. Do NOT load untrusted .ts files.

export interface ScanEntry {
  readonly include: readonly string[];
  readonly exclude?: readonly string[];
}

export interface TypescriptConfig {
  readonly scan: readonly ScanEntry[];
  readonly watch?: boolean;
  readonly watchDebounceMs?: number;
}

export interface ScannerOptions {
  // Working directory used to resolve relative globs in scan[]. When you
  // pass a potemkin.yaml path elsewhere, this is its dirname.
  readonly cwd: string;
}

export interface ScannerResult {
  readonly files: readonly string[];
  readonly registered: readonly RegisteredReducer[];
  /** Scripts discovered via @Script() / defineScript() in the scanned files. */
  readonly scripts: readonly RegisteredScript[];
}

const FORBIDDEN_BUILTINS = new Set([
  'fs', 'node:fs', 'fs/promises', 'node:fs/promises',
  'net', 'node:net',
  'http', 'node:http',
  'https', 'node:https',
  'child_process', 'node:child_process',
  'os', 'node:os',
  'process', 'node:process',
]);

// The SDK reducer + script registries are module-global, so two concurrent
// scans would reset + register into the same registries and collide (e.g. two
// engines booting in parallel for ephemeral isolation, where the second scan's
// @Script registration hits "already registered"). A promise-chain mutex
// serializes the scan phase so scans never interleave.
let scanChain: Promise<void> = Promise.resolve();

export async function scanTypescriptReducers(
  config: TypescriptConfig,
  opts: ScannerOptions,
): Promise<ScannerResult> {
  const prevScan = scanChain;
  let releaseScan!: () => void;
  scanChain = new Promise<void>((resolve) => { releaseScan = resolve; });
  await prevScan;
  try {
    return await scanInner(config, opts);
  } finally {
    releaseScan();
  }
}

async function scanInner(
  config: TypescriptConfig,
  opts: ScannerOptions,
): Promise<ScannerResult> {
  await sdkRegistry.reset();
  sdkScriptRegistry.resetSync();

  const files: string[] = [];
  for (const entry of config.scan) {
    const matched = await glob([...entry.include], {
      cwd: opts.cwd,
      absolute: true,
      onlyFiles: true,
      ignore: entry.exclude ? [...entry.exclude] : undefined,
    });
    for (const m of matched) files.push(m);
  }
  const dedup = [...new Set(files)].sort();

  // Module cache is local to this scan so transpiled exports never leak across
  // scans (or across tests sharing a worker process). A fresh Map per scan
  // means a file re-loaded by a later scan sees its current on-disk content.
  const moduleCache = new Map<string, unknown>();
  for (const file of dedup) {
    loadModule(file, opts.cwd, config.scan, new Set(), moduleCache);
  }

  return {
    files: dedup,
    registered: sdkRegistry.snapshot(),
    scripts: sdkScriptRegistry.snapshot(),
  };
}

interface SandboxRequire {
  (specifier: string): unknown;
}

function loadModule(
  absPath: string,
  cwd: string,
  scan: readonly ScanEntry[],
  inProgress: Set<string>,
  moduleCache: Map<string, unknown>,
): unknown {
  if (inProgress.has(absPath)) {
    throw new BootError(
      'BOOT_ERR_TS_TRANSPILE',
      `Circular sandbox import: ${absPath}`,
      { path: absPath },
    );
  }
  const cached = moduleCache.get(absPath);
  if (cached !== undefined) return cached;

  inProgress.add(absPath);
  try {
    let source: string;
    try {
      source = fs.readFileSync(absPath, 'utf8');
    } catch (e) {
      throw new BootError(
        'BOOT_ERR_TS_TRANSPILE',
        `Cannot read TS reducer file ${absPath}: ${(e as Error).message}`,
        { path: absPath },
      );
    }
    let transpiled: string;
    try {
      transpiled = esbuild.transformSync(source, {
        loader: 'ts',
        format: 'cjs',
        target: 'es2022',
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
      }).code;
    } catch (e) {
      throw new BootError(
        'BOOT_ERR_TS_TRANSPILE',
        `esbuild failed for ${absPath}: ${(e as Error).message}`,
        { path: absPath, message: (e as Error).message },
      );
    }

    // Static safety scan: a TS reducer must not mutate process.env. `process`
    // is absent from the sandbox (so a write would fail at runtime anyway), but
    // we reject it statically with a clear, specific error before execution.
    assertNoEnvMutation(transpiled, absPath);

    const moduleObj = { exports: {} as Record<string, unknown> };
    const requireFn = makeRequire(absPath, cwd, scan, inProgress, moduleCache);
    const wrapper = `(function(module, exports, require, __filename, __dirname){\n${transpiled}\n})(module, module.exports, require, __filename, __dirname);`;

    const ctx = vm.createContext({
      module: moduleObj,
      require: requireFn,
      __filename: absPath,
      __dirname: path.dirname(absPath),
      console: makeSafeConsole(),
      JSON, Math, Date, URL, Object, Array, Error,
      TypeError, RangeError, String, Number, Boolean, Symbol, RegExp, Map, Set, Promise,
    });

    try {
      vm.runInContext(wrapper, ctx, { filename: absPath });
    } catch (e) {
      if (isForbidden(e)) throw e;
      throw new BootError(
        'BOOT_ERR_TS_TRANSPILE',
        `Top-level execution of ${absPath} failed: ${(e as Error).message}`,
        { path: absPath, message: (e as Error).message },
      );
    }

    moduleCache.set(absPath, moduleObj.exports);
    return moduleObj.exports;
  } finally {
    inProgress.delete(absPath);
  }
}

function makeRequire(
  fromFile: string,
  cwd: string,
  scan: readonly ScanEntry[],
  inProgress: Set<string>,
  moduleCache: Map<string, unknown>,
): SandboxRequire {
  return (specifier: string) => {
    if (specifier === '@potemkin/sdk') {
      // Resolve to the in-tree SDK module by reading + transpiling it via
      // the same path so the sandbox shares one registry instance.
      // The eager `import` at the top of this file already loaded the SDK
      // into the host realm; return that here so reducer files register
      // into the shared singleton.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('../sdk/index.js');
    }
    if (FORBIDDEN_BUILTINS.has(specifier)) {
      throw new BootError(
        'SANDBOX_ERR_FORBIDDEN_IMPORT',
        `Forbidden import "${specifier}" in ${fromFile}`,
        { specifier, from: fromFile },
      );
    }
    if (!specifier.startsWith('.')) {
      throw new BootError(
        'SANDBOX_ERR_FORBIDDEN_IMPORT',
        `Non-relative imports are forbidden in TS reducers: "${specifier}"`,
        { specifier, from: fromFile },
      );
    }
    const candidate = path.resolve(path.dirname(fromFile), specifier);
    const resolved = resolveSiblingTs(candidate);
    if (!resolved) {
      throw new BootError(
        'SANDBOX_ERR_IMPORT_OUTSIDE_SCAN',
        `Cannot resolve "${specifier}" from ${fromFile}`,
        { specifier, from: fromFile, candidate },
      );
    }
    if (!isInsideAnyScanDir(resolved, cwd, scan)) {
      throw new BootError(
        'SANDBOX_ERR_IMPORT_OUTSIDE_SCAN',
        `Import "${specifier}" resolves outside any typescript.scan[] directory: ${resolved}`,
        { specifier, from: fromFile, resolved },
      );
    }
    return loadModule(resolved, cwd, scan, inProgress, moduleCache);
  };
}

function resolveSiblingTs(candidate: string): string | null {
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  for (const ext of ['.ts', '.tsx', '/index.ts']) {
    const withExt = candidate + ext;
    if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) return withExt;
  }
  return null;
}

function isInsideAnyScanDir(
  resolved: string,
  cwd: string,
  scan: readonly ScanEntry[],
): boolean {
  for (const entry of scan) {
    for (const inc of entry.include) {
      const incRoot = path.resolve(cwd, stripGlobTail(inc));
      const rel = path.relative(incRoot, resolved);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
    }
  }
  return false;
}

function stripGlobTail(pattern: string): string {
  // Everything up to the first glob magic char is the literal root.
  const idx = pattern.search(/[*?[{]/);
  const head = idx < 0 ? pattern : pattern.slice(0, idx);
  return head.endsWith('/') ? head.slice(0, -1) : head;
}

function makeSafeConsole(): Console {
  // Pass-through to host console — capture happens at the engine logger
  // when registry inspection runs.
  const passthrough = (..._args: unknown[]): void => {
    /* swallowed — reducer files SHOULD NOT log during registration */
  };
  return {
    log: passthrough,
    info: passthrough,
    warn: passthrough,
    error: passthrough,
    debug: passthrough,
    trace: passthrough,
  } as unknown as Console;
}

function isForbidden(e: unknown): e is BootError {
  if (!(e instanceof BootError)) return false;
  const code = e.code;
  return (
    code === 'SANDBOX_ERR_FORBIDDEN_IMPORT' ||
    code === 'SANDBOX_ERR_IMPORT_OUTSIDE_SCAN' ||
    code === 'SANDBOX_ERR_PROCESS_CONTROL' ||
    code === 'SANDBOX_ERR_ENV_MUTATION'
  );
}

/**
 * Reject any WRITE to `process.env` in a TS reducer with SANDBOX_ERR_ENV_MUTATION.
 * Runs on the transpiled (comment- and type-stripped) source so comments/strings
 * and TS syntax don't produce false hits. Detects member assignment
 * (`process.env.X = …` / `process.env['X'] = …`, including compound/`++`/`--`),
 * `delete process.env.X`, and `Object.assign|defineProperty(process.env, …)`.
 * Reads of process.env are not flagged (only mutations); `process` itself is
 * absent from the sandbox so reads resolve to undefined regardless.
 */
const ENV_WRITE_PATTERNS: readonly RegExp[] = [
  // process.env.X = / += / ... / ++ / -- and process.env['X'] = ...
  /process\s*\.\s*env\s*(?:\.\s*[A-Za-z_$][\w$]*|\[[^\]]*\])\s*(?:\+\+|--|(?:\+|-|\*|\/|%|\*\*|&&|\|\||\?\?|&|\||\^|<<|>>|>>>)?=(?!=))/,
  // delete process.env.X
  /delete\s+process\s*\.\s*env\b/,
  // Object.assign(process.env, …) / Object.defineProperty(process.env, …)
  /Object\s*\.\s*(?:assign|defineProperty|defineProperties)\s*\(\s*process\s*\.\s*env\b/,
];

function assertNoEnvMutation(transpiledSource: string, absPath: string): void {
  for (const re of ENV_WRITE_PATTERNS) {
    if (re.test(transpiledSource)) {
      throw new BootError(
        'SANDBOX_ERR_ENV_MUTATION',
        `TS reducer ${absPath} mutates process.env — reducers must be pure and may not modify the host environment.`,
        { path: absPath },
      );
    }
  }
}
