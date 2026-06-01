import * as vm from 'node:vm';
import type { Logger } from '../observability/logger.js';
import type { ScriptContext, ScriptHandle } from './types.js';
import { InternalExecutionError } from '../errors.js';

const SCRIPT_TIMEOUT_MS = 50;

/**
 * UUID pool size: pre-generate this many UUIDs from the host side before
 * entering the vm, so realm-native helpers.uuid() can serve multiple calls
 * per reducer invocation without touching any host-realm function inside the vm.
 */
const UUID_POOL_SIZE = 10;

/**
 * Compile the transpiled CJS JS into a ScriptHandle.
 * At invocation time, the script is re-run in a fresh vm context per call
 * with a 50ms timeout.
 *
 * Security model:
 * - The vm context receives NO host-realm objects or functions. Any host-realm
 *   object injected into vm.createContext is reachable via .constructor chains
 *   and allows escape to the host Function constructor → full RCE.
 * - JSON, Math, Date are realm-native in every vm context and require no injection.
 * - URL is not available in vm realm and is not injected.
 * - console is realm-native in every vm context; no injection needed.
 * - ScriptContext data (command/state/payload/event) is serialised to a JSON
 *   string primitive and deserialised inside the realm via a bootstrap script.
 * - Helper functions (uuid, now) are pre-evaluated on the host side and their
 *   string results are injected as primitives (safe: string.constructor resolves
 *   to the vm-realm String, not the host Function).
 * - deepClone/deepMerge helpers are re-implemented in the realm bootstrap using
 *   the realm-native JSON global (equivalent for plain JSON data).
 * - logger is provided as a realm-native no-op object; reducers rarely log and
 *   the host Logger cannot be injected safely.
 */
export function instantiateScript(
  name: string,
  boundary: string,
  transpiledCode: string,
  logger: Logger,
): ScriptHandle {
  const childLog = logger.child({ scriptName: name, boundary });

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

  const handle: ScriptHandle = {
    name,
    boundary,
    source: transpiledCode,
    fn: (ctx: ScriptContext) =>
      invokeWithCode(name, boundary, wrappedForExecution, ctx, childLog),
  };

  return handle;
}

function invokeWithCode(
  name: string,
  boundary: string,
  wrappedCode: string,
  ctx: ScriptContext,
  _log: Logger,
): unknown {
  // ---------------------------------------------------------------------------
  // Build a completely host-free vm context.
  //
  // SECURITY INVARIANT: vm.createContext MUST receive only primitive values
  // (string, number, boolean, null, undefined). Any object or function value
  // injected here is a host-realm value; its .constructor resolves to the host
  // Function, enabling: injectedObj.constructor.constructor("return process")().
  //
  // Safe injections (primitives only):
  //   __ctxDataJson__ — JSON-serialised plain-data portions of ScriptContext
  //   __uuidPool__    — JSON array of pre-generated UUID strings
  //   __nowVal__      — pre-evaluated ISO timestamp string
  //
  // Everything else (JSON, Math, Date, console) is already realm-native.
  // URL is not available in vm realm and is not injected.
  // ---------------------------------------------------------------------------

  // Pre-evaluate host-side helper results before entering the vm.
  const uuidPool: string[] = [];
  for (let i = 0; i < UUID_POOL_SIZE; i++) {
    uuidPool.push(ctx.helpers.uuid());
  }

  const ctxData = {
    command: ctx.command,
    state: ctx.state,
    payload: ctx.payload,
    event: ctx.event ?? null,
  };

  const safeContext = vm.createContext({
    __ctxDataJson__: JSON.stringify(ctxData),
    __uuidPoolJson__: JSON.stringify(uuidPool),
    __nowVal__: ctx.helpers.now(),
  });

  // Bootstrap: reconstruct __ctx__ from primitives using only realm-native
  // objects and functions. No host-realm value is referenced here.
  // Run as a top-level (non-IIFE) script so __ctx__ is visible in the vm
  // context's global scope and accessible to the reducer script that runs next.
  const bootstrapScriptTopLevel = `
'use strict';
var _ctxData = JSON.parse(__ctxDataJson__);
var _uuidPool = JSON.parse(__uuidPoolJson__);
var _uuidIdx = 0;

function _deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function _deepMerge(target, source) {
  var result = _deepClone(target);
  var keys = Object.keys(source);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var sv = source[k];
    var tv = result[k];
    if (sv !== null && typeof sv === 'object' && !Array.isArray(sv) &&
        tv !== null && tv !== undefined && typeof tv === 'object' && !Array.isArray(tv)) {
      result[k] = _deepMerge(tv, sv);
    } else {
      result[k] = sv;
    }
  }
  return result;
}

var _noopLogger = {
  info: function() {},
  warn: function() {},
  error: function() {},
  debug: function() {},
  child: function() { return _noopLogger; },
};

var __ctx__ = {
  command: _ctxData.command,
  state: _ctxData.state,
  payload: _ctxData.payload,
  event: _ctxData.event,
  helpers: {
    uuid: function() {
      var val = _uuidPool[_uuidIdx];
      if (_uuidIdx < _uuidPool.length - 1) _uuidIdx++;
      return val;
    },
    now: function() { return __nowVal__; },
    deepClone: _deepClone,
    deepMerge: _deepMerge,
  },
  logger: _noopLogger,
};
`;

  const bootstrapVmScript = new vm.Script(bootstrapScriptTopLevel, {
    filename: `<sandbox-bootstrap:${boundary}:${name}>`,
  });

  const script = new vm.Script(wrappedCode, { filename: `<script:${boundary}:${name}>` });

  try {
    bootstrapVmScript.runInContext(safeContext);
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
    if (err instanceof InternalExecutionError) throw err;

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
 * Invoke a ScriptHandle with a ScriptContext.
 * The handle.fn already encapsulates the sandbox execution.
 */
export function invokeScript(handle: ScriptHandle, ctx: ScriptContext): unknown {
  return handle.fn(ctx);
}
