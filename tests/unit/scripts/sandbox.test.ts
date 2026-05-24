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
