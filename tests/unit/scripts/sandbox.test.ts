import { instantiateScript, invokeScript } from '../../../src/scripts/sandbox.js';
import { transpileScript } from '../../../src/scripts/transpile.js';
import { InternalExecutionError } from '../../../src/errors.js';
import { createLogger } from '../../../src/observability/logger.js';
import type { ScriptContext } from '../../../src/scripts/types.js';

function makeCtx(overrides: Partial<ScriptContext> = {}): ScriptContext {
  const logger = createLogger({ name: 'test' });
  return {
    command: {
      commandId: 'cmd-1',
      boundary: 'TestBoundary',
      intent: 'mutation',
      targetId: 'agg-1',
      payload: {},
      queryParams: {},
      httpMethod: 'PUT',
      path: '/test',
      origin: 'inbound' as const,
      depth: 0,
    },
    state: { balance: 100 },
    payload: {},
    helpers: {
      uuid: () => '00000000-0000-0000-0000-000000000001',
      now: () => '2025-01-01T00:00:00.000Z',
      deepClone: <T>(v: T) => JSON.parse(JSON.stringify(v)) as T,
      deepMerge: (a, b) => ({ ...a, ...b }),
    },
    logger,
    ...overrides,
  };
}

const logger = createLogger({ name: 'test-sandbox' });

function compileAndInstantiate(code: string, name = 'testScript', boundary = 'TestBoundary') {
  const transpiled = transpileScript(name, boundary, code);
  return instantiateScript(name, boundary, transpiled, logger);
}

describe('instantiateScript / invokeScript', () => {
  it('executes a simple script and returns the result', () => {
    const code = `export default (ctx) => ctx.state.balance * 2;`;
    const handle = compileAndInstantiate(code);
    const result = invokeScript(handle, makeCtx());
    expect(result).toBe(200);
  });

  it('returns a boolean result correctly', () => {
    const code = `export default (ctx) => ctx.state.balance > 50;`;
    const handle = compileAndInstantiate(code);
    expect(invokeScript(handle, makeCtx())).toBe(true);
    expect(invokeScript(handle, makeCtx({ state: { balance: 10 } }))).toBe(false);
  });

  it('can use helpers from context', () => {
    const code = `export default (ctx) => ctx.helpers.uuid();`;
    const handle = compileAndInstantiate(code);
    const result = invokeScript(handle, makeCtx());
    expect(result).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('can use JSON global in sandbox', () => {
    const code = `export default (ctx) => JSON.stringify(ctx.state);`;
    const handle = compileAndInstantiate(code);
    const result = invokeScript(handle, makeCtx());
    expect(typeof result).toBe('string');
    expect(JSON.parse(result as string)).toEqual({ balance: 100 });
  });

  it('can use Math global in sandbox', () => {
    const code = `export default (ctx) => Math.round(ctx.state.balance * 1.5);`;
    const handle = compileAndInstantiate(code);
    const result = invokeScript(handle, makeCtx());
    expect(result).toBe(150);
  });

  it('wraps script errors in InternalExecutionError with SCRIPT_EXECUTION_FAILED', () => {
    const code = `export default () => { throw new Error('test error'); };`;
    const handle = compileAndInstantiate(code);
    expect(() => invokeScript(handle, makeCtx())).toThrow(InternalExecutionError);
    try {
      invokeScript(handle, makeCtx());
    } catch (err) {
      expect(err instanceof InternalExecutionError).toBe(true);
      const details = (err as InternalExecutionError).details as Record<string, unknown>;
      expect(details['code']).toBe('SCRIPT_EXECUTION_FAILED');
      expect(details['scriptName']).toBe('testScript');
    }
  });

  it('enforces timeout: throws InternalExecutionError with SCRIPT_TIMEOUT', () => {
    const code = `export default () => { while(true) {} };`;
    const handle = compileAndInstantiate(code);
    expect(() => invokeScript(handle, makeCtx())).toThrow(InternalExecutionError);
    try {
      invokeScript(handle, makeCtx());
    } catch (err) {
      expect(err instanceof InternalExecutionError).toBe(true);
      const details = (err as InternalExecutionError).details as Record<string, unknown>;
      expect(details['code']).toBe('SCRIPT_TIMEOUT');
    }
  }, 10000);

  it('does not expose fs in the sandbox', () => {
    const code = `
      export default () => {
        try {
          const fs = require('fs');
          return 'should not reach here';
        } catch(e) {
          return 'no-fs';
        }
      };
    `;
    const handle = compileAndInstantiate(code);
    const result = invokeScript(handle, makeCtx());
    expect(result).toBe('no-fs');
  });

  it('does not expose process in the sandbox', () => {
    const code = `
      export default () => {
        try {
          return typeof process !== 'undefined' ? process.version : 'no-process';
        } catch(e) {
          return 'no-process';
        }
      };
    `;
    const handle = compileAndInstantiate(code);
    const result = invokeScript(handle, makeCtx());
    expect(result).toBe('no-process');
  });
});

describe('sandbox security — vm escape prevention', () => {
  it('Object.constructor("return process")() does not yield host process', () => {
    // Injecting the host-realm Object allowed: Object.constructor === Function (host),
    // so Object.constructor("return process")() returned the host process object.
    // After the fix (no host-realm Object injected), the vm-realm Object.constructor
    // is the vm-realm Function, which cannot access identifiers outside the context.
    const code = `
      export default () => {
        try {
          const result = Object.constructor("return process")();
          return result != null ? 'ESCAPED' : 'blocked';
        } catch(e) {
          return 'blocked:' + e.message;
        }
      };
    `;
    const handle = compileAndInstantiate(code);
    const result = invokeScript(handle, makeCtx()) as string;
    expect(result).not.toBe('ESCAPED');
    expect(result).toMatch(/^blocked/);
  });

  it('this.constructor.constructor("return process")() does not yield host process', () => {
    // Without strict mode in the wrapper IIFE, 'this' inside the function refers to
    // the vm context object (a host-realm plain object), whose .constructor is the
    // host Object, and .constructor.constructor is the host Function.
    // With 'use strict', 'this' in the IIFE is undefined, blocking this escape path.
    const code = `
      export default () => {
        try {
          const result = this.constructor.constructor("return process")();
          return result != null ? 'ESCAPED' : 'blocked';
        } catch(e) {
          return 'blocked:' + e.message;
        }
      };
    `;
    const handle = compileAndInstantiate(code);
    const result = invokeScript(handle, makeCtx()) as string;
    expect(result).not.toBe('ESCAPED');
    expect(result).toMatch(/^blocked/);
  });

  it('rejects a reducer that returns a Promise with SCRIPT_ASYNC_RESULT', () => {
    const code = `export default () => Promise.resolve(42);`;
    const handle = compileAndInstantiate(code);
    expect(() => invokeScript(handle, makeCtx())).toThrow(InternalExecutionError);
    try {
      invokeScript(handle, makeCtx());
    } catch (err) {
      expect(err instanceof InternalExecutionError).toBe(true);
      const details = (err as InternalExecutionError).details as Record<string, unknown>;
      expect(details['code']).toBe('SCRIPT_ASYNC_RESULT');
      expect(details['scriptName']).toBe('testScript');
    }
  });

  it('rejects an async reducer (Promise.resolve().then(...)) with SCRIPT_ASYNC_RESULT', () => {
    // A reducer returning a pending thenable returns synchronously from vm.runInContext,
    // but its microtask continuation runs on the host event loop — bypassing the timeout.
    const code = `export default () => Promise.resolve().then(() => 99);`;
    const handle = compileAndInstantiate(code);
    try {
      invokeScript(handle, makeCtx());
      fail('expected InternalExecutionError');
    } catch (err) {
      expect(err instanceof InternalExecutionError).toBe(true);
      const details = (err as InternalExecutionError).details as Record<string, unknown>;
      expect(details['code']).toBe('SCRIPT_ASYNC_RESULT');
    }
  });

  it('transpiled TypeScript reducer using Object/Array/Map/Set/Error works end-to-end', () => {
    // Verifies that removing host-realm constructor injections does not break
    // legitimate reducers. The esbuild CJS preamble uses Object.defineProperty,
    // Object.getOwnPropertyNames, etc., which rely on the vm-realm native Object.
    const code = `
      export default function reducer(ctx: { state: { balance: number } }) {
        const keys = Object.keys(ctx.state);
        const arr = Array.from(keys);
        const map = new Map(arr.map((k: string, i: number) => [k, i] as [string, number]));
        const set = new Set([1, 2, 3]);
        const err = new Error('ok');
        return {
          keysLen: keys.length,
          arrLen: arr.length,
          mapSize: map.size,
          setSize: set.size,
          hasErr: err.message === 'ok',
        };
      }
    `;
    const handle = compileAndInstantiate(code);
    const result = invokeScript(handle, makeCtx()) as Record<string, unknown>;
    expect(result.keysLen).toBe(1);
    expect(result.arrLen).toBe(1);
    expect(result.mapSize).toBe(1);
    expect(result.setSize).toBe(3);
    expect(result.hasErr).toBe(true);
  });
});
