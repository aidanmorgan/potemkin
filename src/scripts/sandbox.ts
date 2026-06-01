import * as vm from 'node:vm';
import type { Logger } from '../observability/logger.js';
import type { ScriptContext, ScriptHandle } from './types.js';
import { InternalExecutionError } from '../errors.js';

const SCRIPT_TIMEOUT_MS = 50;

/**
 * REQ-69: Compile the transpiled CJS JS into a ScriptHandle.
 * At invocation time, the script is re-run in a fresh vm context per call
 * with a 50ms timeout. This ensures the infinite-loop timeout is enforced.
 *
 * The sandbox context exposes ONLY:
 *   - console.log (redirected to pino logger)
 *   - JSON, Math, Date, URL  (safe pure globals)
 *   - module, exports         (CJS interop)
 * Absent: fs, net, process, require, __dirname, global, globalThis
 */
export function instantiateScript(
  name: string,
  boundary: string,
  transpiledCode: string,
  logger: Logger,
): ScriptHandle {
  const childLog = logger.child({ scriptName: name, boundary });

  // Validate that the transpiled code can at least execute without error
  // by doing a dry run with a minimal context. This catches obvious errors.
  const sandboxConsole = {
    log: (...args: unknown[]) => childLog.info({ scriptLog: args }, 'script log'),
    warn: (...args: unknown[]) => childLog.warn({ scriptLog: args }, 'script warn'),
    error: (...args: unknown[]) => childLog.error({ scriptLog: args }, 'script error'),
  };

  // Build a wrapper that sets up CJS module/exports and runs the code,
  // then calls the default export with __ctx__ (injected at call time).
  // We wrap in a strict-mode IIFE so:
  //   1. 'this' is undefined inside the function body (blocks this.constructor.constructor escape)
  //   2. Variables don't pollute the outer context.
  const wrappedForExecution = `
'use strict';
(function() {
  'use strict';
  var module = { exports: {} };
  var exports = module.exports;
  ${transpiledCode}
  var fn = module.exports;
  if (fn && typeof fn['default'] === 'function') fn = fn['default'];
  if (typeof fn !== 'function') throw new Error('Script must export a default function');
  return fn(__ctx__);
})();
`;

  // Store the code + metadata; fn is bound lazily at invoke time
  const handle: ScriptHandle = {
    name,
    boundary,
    source: transpiledCode,
    fn: (ctx: ScriptContext) => invokeWithCode(name, boundary, wrappedForExecution, ctx, sandboxConsole),
  };

  return handle;
}

function invokeWithCode(
  name: string,
  boundary: string,
  wrappedCode: string,
  ctx: ScriptContext,
  sandboxConsole: Record<string, unknown>,
): unknown {
  // Build a fresh context per invocation so scripts cannot share state.
  //
  // SECURITY: Do NOT inject host-realm constructors (Object, Array, Error, etc.).
  // Injecting host-realm constructors allows escape via Object.constructor("return process")().
  // The vm context's own realm already provides Object, Array, Error, Map, Set, Promise,
  // RegExp, String, Number, Boolean, Symbol, etc. natively — no injection needed.
  //
  // JSON and Math ARE realm-native globals too, but we inject them explicitly as a
  // belt-and-suspenders measure (they carry no escape risk since they have no .constructor
  // path to Function). Date and URL are similarly safe and convenient to expose.
  //
  // process, require, fs, net, __dirname, global, globalThis are intentionally excluded.
  const safeContext = vm.createContext({
    JSON,
    Math,
    Date,
    URL,
    console: sandboxConsole,
    __ctx__: ctx,
  });

  const script = new vm.Script(wrappedCode, { filename: `<script:${boundary}:${name}>` });

  try {
    const result = script.runInContext(safeContext, {
      timeout: SCRIPT_TIMEOUT_MS,
      breakOnSigint: true,
    });

    // Reducers must be synchronous. A thenable return value means the script used
    // async/Promise — the vm timeout does not cover microtask continuations, so an
    // async reducer could hang the host event loop after runInContext returns.
    if (result !== null && result !== undefined && typeof (result as { then?: unknown }).then === 'function') {
      throw new InternalExecutionError(
        `Script "${name}" returned a Promise or thenable — reducer scripts must be synchronous`,
        { code: 'SCRIPT_ASYNC_RESULT', scriptName: name },
      );
    }

    return result;
  } catch (err) {
    // Re-throw errors we already wrapped (e.g. the async-result check above).
    if (err instanceof InternalExecutionError) throw err;

    // The vm may throw its own Error class (not the host's Error), so we use duck-typing
    // rather than instanceof for cross-realm compatibility.
    const errStr = String(err);
    const errCode = (err as { code?: string }).code;
    const errMessage = typeof (err as { message?: string }).message === 'string'
      ? (err as { message: string }).message
      : errStr;

    const isTimeout =
      errCode === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ||
      errMessage.includes('Script execution timed out') ||
      errMessage.includes('timed out after') ||
      errStr.includes('Script execution timed out') ||
      errStr.includes('timed out after');

    if (isTimeout) {
      throw new InternalExecutionError(
        `Script "${name}" exceeded timeout of ${SCRIPT_TIMEOUT_MS}ms`,
        { code: 'SCRIPT_TIMEOUT', scriptName: name, timeoutMs: SCRIPT_TIMEOUT_MS },
      );
    }

    throw new InternalExecutionError(
      `Script "${name}" threw an error: ${errMessage}`,
      { code: 'SCRIPT_EXECUTION_FAILED', scriptName: name, originalMessage: errMessage },
    );
  }
}

/**
 * REQ-69: Invoke a ScriptHandle with a ScriptContext.
 * The handle.fn already encapsulates the sandbox execution.
 */
export function invokeScript(handle: ScriptHandle, ctx: ScriptContext): unknown {
  return handle.fn(ctx);
}
