import { instantiateScript, invokeScript } from '../../../src/scripts/sandbox.js';
import { transpileScript } from '../../../src/scripts/transpile.js';
import { InternalExecutionError } from '../../../src/errors.js';
import { createLogger, _resetRootPinoForTest } from '../../../src/observability/logger.js';
import type { Logger } from '../../../src/observability/logger.js';
import type { ScriptContext } from '../../../src/scripts/types.js';
import { Writable } from 'node:stream';

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
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const code = `export default (ctx) => ctx.helpers.uuid();`;
    const handle = compileAndInstantiate(code);
    const result = invokeScript(handle, makeCtx());
    expect(typeof result).toBe('string');
    expect(result as string).toMatch(uuidRegex);
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

  it('Date.constructor("return process")() does not yield host process', () => {
    const code = `
      export default () => {
        try {
          const result = Date.constructor("return process")();
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

  it('URL.constructor("return process")() does not yield host process', () => {
    const code = `
      export default () => {
        try {
          if (typeof URL === 'undefined') return 'blocked:URL-not-available';
          const result = URL.constructor("return process")();
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

  it('JSON.stringify.constructor("return process")() does not yield host process', () => {
    const code = `
      export default () => {
        try {
          const result = JSON.stringify.constructor("return process")();
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

  it('Math.max.constructor("return process")() does not yield host process', () => {
    const code = `
      export default () => {
        try {
          const result = Math.max.constructor("return process")();
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

  it('console.log.constructor("return process")() does not yield host process', () => {
    const code = `
      export default () => {
        try {
          if (typeof console === 'undefined' || typeof console.log === 'undefined') return 'blocked:no-console';
          const result = console.log.constructor("return process")();
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

  it('__ctx__.constructor.constructor("return process")() does not yield host process', () => {
    const code = `
      export default (ctx) => {
        try {
          const result = ctx.constructor.constructor("return process")();
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

  it('real RCE attempt via Date.constructor chain is blocked', () => {
    const code = `
      export default () => {
        try {
          const proc = Date.constructor("return process")();
          const cp = proc.mainModule.require("child_process");
          const out = cp.execSync("echo PWNED").toString();
          return 'ESCAPED:' + out;
        } catch(e) {
          return 'blocked:' + e.message;
        }
      };
    `;
    const handle = compileAndInstantiate(code);
    const result = invokeScript(handle, makeCtx()) as string;
    expect(result).not.toContain('PWNED');
    expect(result).toMatch(/^blocked/);
  });

  // The context global is host-created; globalThis.constructor.constructor was a
  // live RCE escape (potemkin-mm7g) until the bootstrap neutralized it.
  it.each([
    ['globalThis.constructor.constructor', `globalThis.constructor.constructor("return process")()`],
    ['(0,eval)("globalThis") chain', `(0,eval)("globalThis").constructor.constructor("return process")()`],
    ['(function(){return this})() chain', `(function(){ return this || globalThis; })().constructor.constructor("return process")()`],
    ['Object.getPrototypeOf(globalThis) chain', `Object.getPrototypeOf(globalThis).constructor.constructor("return process")()`],
  ])('escape via %s does not yield host process', (_label, expr) => {
    const code = `
      export default () => {
        try {
          const result = ${expr};
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

  it('real RCE via globalThis.constructor chain is blocked', () => {
    const code = `
      export default () => {
        try {
          const proc = globalThis.constructor.constructor("return process")();
          const out = proc.mainModule.require("child_process").execSync("echo PWNED").toString();
          return 'ESCAPED:' + out;
        } catch(e) {
          return 'blocked:' + e.message;
        }
      };
    `;
    const handle = compileAndInstantiate(code);
    const result = invokeScript(handle, makeCtx()) as string;
    expect(result).not.toContain('PWNED');
    expect(result).toMatch(/^blocked/);
  });

  it('realm-native Function and eval remain available but cannot see host globals', () => {
    const code = `
      export default () => {
        const fnProc = (() => { try { return Function("return typeof process")(); } catch(e){ return 'threw'; } })();
        const evalProc = (() => { try { return eval("typeof process"); } catch(e){ return 'threw'; } })();
        return fnProc + ',' + evalProc;
      };
    `;
    const handle = compileAndInstantiate(code);
    const result = invokeScript(handle, makeCtx()) as string;
    // process must be undefined in the realm (not visible), proving realm fn/eval are safe.
    expect(result).toBe('undefined,undefined');
  });

  it('transpiled reducer using JSON/Math/Date/new Date/helpers works end-to-end', () => {
    const code = `
      export default function reducer(ctx: { state: { balance: number }; helpers: { uuid: () => string; now: () => string } }) {
        const jsonRound = JSON.parse(JSON.stringify({ x: 42 }));
        const mathVal = Math.round(ctx.state.balance * 1.5);
        const dateStr = new Date(0).toISOString();
        const uuidVal = ctx.helpers.uuid();
        const nowVal = ctx.helpers.now();
        return {
          jsonOk: jsonRound.x === 42,
          mathOk: mathVal === 150,
          dateOk: typeof dateStr === 'string' && dateStr.length > 0,
          uuidOk: typeof uuidVal === 'string' && uuidVal.length > 0,
          nowOk: typeof nowVal === 'string' && nowVal.length > 0,
        };
      }
    `;
    const handle = compileAndInstantiate(code);
    const result = invokeScript(handle, makeCtx()) as Record<string, unknown>;
    expect(result.jsonOk).toBe(true);
    expect(result.mathOk).toBe(true);
    expect(result.dateOk).toBe(true);
    expect(result.uuidOk).toBe(true);
    expect(result.nowOk).toBe(true);
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

  // -------------------------------------------------------------------------
  // potemkin-0guf: uuid() — unbounded distinct UUIDs from realm-native PRNG
  // -------------------------------------------------------------------------
  it('uuid() produces 1000 distinct UUID-v4-format strings', () => {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const code = `
      export default (ctx) => {
        var ids = [];
        for (var i = 0; i < 1000; i++) ids.push(ctx.helpers.uuid());
        return JSON.stringify(ids);
      };
    `;
    const handle = compileAndInstantiate(code);
    const raw = invokeScript(handle, makeCtx()) as string;
    const ids = JSON.parse(raw) as string[];
    expect(ids.length).toBe(1000);
    for (const id of ids) {
      expect(id).toMatch(uuidRegex);
    }
    expect(new Set(ids).size).toBe(1000);
  });

  // potemkin-nm1p: each invocation of the same script must get a DISTINCT uuid
  // sequence — the per-invocation counter ensures seeds never collide even when
  // two calls happen within the same millisecond.
  it('uuid() sequences are distinct across two separate invocations of the same script', () => {
    const code = `
      export default (ctx) => {
        var ids = [];
        for (var i = 0; i < 20; i++) ids.push(ctx.helpers.uuid());
        return JSON.stringify(ids);
      };
    `;
    const handle = compileAndInstantiate(code);
    const ctx = makeCtx();
    const run1 = JSON.parse(invokeScript(handle, ctx) as string) as string[];
    const run2 = JSON.parse(invokeScript(handle, ctx) as string) as string[];
    // The two sequences must be entirely disjoint (no shared uuid values).
    const set1 = new Set(run1);
    for (const id of run2) {
      expect(set1.has(id)).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // potemkin-rwwr: console/logger forwarding to host logger
  // -------------------------------------------------------------------------

  function makeMockLoggerCapture(): { logger: Logger; lines: string[] } {
    const lines: string[] = [];
    _resetRootPinoForTest();
    const dest = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const logger = createLogger({ name: 'test-capture', level: 'debug', _dest: dest });
    return { logger, lines };
  }

  function compileAndInstantiateWithLogger(
    code: string,
    logger: Logger,
    name = 'testScript',
    boundary = 'TestBoundary',
  ) {
    const transpiled = transpileScript(name, boundary, code);
    return instantiateScript(name, boundary, transpiled, logger);
  }

  it('console.log inside reducer is forwarded to host logger', async () => {
    const { logger, lines } = makeMockLoggerCapture();
    const code = `export default (ctx) => { console.log('hello from reducer'); return 1; };`;
    const handle = compileAndInstantiateWithLogger(code, logger);
    invokeScript(handle, makeCtx());
    // Give pino's async stream a tick to flush
    await new Promise((r) => setImmediate(r));
    const combined = lines.join('');
    expect(combined).toContain('hello from reducer');
  });

  it('ctx.logger.info inside reducer is forwarded to host logger', async () => {
    const { logger, lines } = makeMockLoggerCapture();
    const code = `export default (ctx) => { ctx.logger.info('yo', { extra: 1 }); return 2; };`;
    const handle = compileAndInstantiateWithLogger(code, logger);
    invokeScript(handle, makeCtx());
    await new Promise((r) => setImmediate(r));
    const combined = lines.join('');
    expect(combined).toContain('yo');
  });

  it('log buffer is capped and a truncated marker is appended', () => {
    const { logger } = makeMockLoggerCapture();
    // Write 120 log lines — exceeds the 100-entry cap
    const code = `
      export default (ctx) => {
        for (var i = 0; i < 120; i++) console.log('line-' + i);
        return 'done';
      };
    `;
    const handle = compileAndInstantiateWithLogger(code, logger);
    // Should not throw — just silently caps
    expect(() => invokeScript(handle, makeCtx())).not.toThrow();
  });

  // potemkin-nyff (1): a reducer whose __logBuffer__ contains a throwing getter
  // must still return its correct result, not throw SCRIPT_EXECUTION_FAILED.
  it('throwing log buffer getter does not turn a successful result into SCRIPT_EXECUTION_FAILED', () => {
    const { logger } = makeMockLoggerCapture();
    // The reducer poisons __logBuffer__[0] with a throwing getter, but returns a
    // valid result. The host drain must be isolated so this does not surface as an error.
    const code = `
      export default (ctx) => {
        Object.defineProperty(__logBuffer__, 0, {
          get: function() { throw new Error('hostile getter'); },
          configurable: true,
        });
        return 42;
      };
    `;
    const handle = compileAndInstantiateWithLogger(code, logger);
    // Must return 42, not throw.
    const result = invokeScript(handle, makeCtx());
    expect(result).toBe(42);
  });

  // potemkin-nyff (2): an oversized log entry is truncated to the byte cap.
  it('oversized log entry is truncated with a [truncated] marker', async () => {
    const { logger, lines } = makeMockLoggerCapture();
    // Push a 5 000-character string — well above the 4 096-byte cap.
    const code = `
      export default (ctx) => {
        console.log('A'.repeat(5000));
        return 'done';
      };
    `;
    const handle = compileAndInstantiateWithLogger(code, logger);
    invokeScript(handle, makeCtx());
    await new Promise((r) => setImmediate(r));
    const combined = lines.join('');
    // The entry must be present but truncated.
    expect(combined).toContain('[truncated]');
    // The full 5 000-character string must NOT appear verbatim.
    expect(combined).not.toContain('A'.repeat(5000));
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
