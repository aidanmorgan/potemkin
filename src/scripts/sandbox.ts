import * as vm from 'node:vm';
import type { Logger } from '../observability/logger.js';
import type { ScriptContext, ScriptHandle } from './types.js';
import { InternalExecutionError } from '../errors.js';

const SCRIPT_TIMEOUT_MS = 50;

/**
 * Maximum number of log entries the realm-side buffer will collect per
 * invocation. Entries beyond this limit are dropped and a truncated marker
 * is appended instead.
 */
const LOG_BUFFER_CAP = 100;

/**
 * Derive a 32-bit unsigned integer seed from a string using a simple djb2-style
 * hash. The result is a primitive number, safe to inject into the vm context.
 */
function deriveNumericSeed(s: string): number {
  let h = 2166136261; // FNV-1a 32-bit offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (Math.imul(h, 16777619)) >>> 0;
  }
  return h >>> 0;
}

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
 * - console is overridden inside the realm by the bootstrap to push to a buffer;
 *   no host-realm console is injected.
 * - ScriptContext data (command/state/payload/event) is serialised to a JSON
 *   string primitive and deserialised inside the realm via a bootstrap script.
 * - uuid() is implemented in the realm bootstrap via a mulberry32 PRNG seeded
 *   from __uuidSeed__ (a primitive number derived host-side). This produces
 *   unbounded distinct UUID-v4-format strings without any host-realm function.
 * - now() helper is pre-evaluated host-side and injected as a string primitive.
 * - deepClone/deepMerge helpers are re-implemented in the realm bootstrap using
 *   the realm-native JSON global (equivalent for plain JSON data).
 * - console.* and ctx.logger.* push entries into a realm-side bounded array
 *   (__logBuffer__). After runInContext returns, entries are read as plain
 *   primitive strings (safe) and forwarded to the host childLog logger.
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
  //   __uuidSeed__    — primitive number seed for the realm-native PRNG
  //   __nowVal__      — pre-evaluated ISO timestamp string
  //   __logBufCap__   — primitive number cap for the log buffer
  //
  // Everything else (JSON, Math, Date) is already realm-native.
  // URL is not available in vm realm and is not injected.
  // console is overridden in the bootstrap script using realm-native functions.
  // ---------------------------------------------------------------------------

  const nowVal = ctx.helpers.now();

  const ctxData = {
    command: ctx.command,
    state: ctx.state,
    payload: ctx.payload,
    event: ctx.event ?? null,
  };

  // Derive a deterministic numeric seed from the script name + current timestamp.
  // Both inputs are already primitives; deriveNumericSeed runs on the host side
  // and the result is injected as a plain number.
  const uuidSeed: number = deriveNumericSeed(`${name}:${boundary}:${nowVal}`);

  const safeContext = vm.createContext({
    __ctxDataJson__: JSON.stringify(ctxData),
    __uuidSeed__: uuidSeed,
    __nowVal__: nowVal,
    __logBufCap__: LOG_BUFFER_CAP,
  });

  // Bootstrap: reconstruct __ctx__ from primitives using only realm-native
  // objects and functions. No host-realm value is referenced here.
  // Run as a top-level (non-IIFE) script so __ctx__ is visible in the vm
  // context's global scope and accessible to the reducer script that runs next.
  //
  // uuid() uses a mulberry32 PRNG seeded from __uuidSeed__ (a primitive number).
  // It generates UUID-v4-format strings on demand — unbounded and always distinct
  // for a given seed because the internal state counter increments on every call.
  //
  // Log entries are pushed into __logBuffer__ (bounded by __logBufCap__).
  // After script.runInContext, the host reads this array as primitive strings.
  const bootstrapScriptTopLevel = `
'use strict';
var _ctxData = JSON.parse(__ctxDataJson__);

// ---- mulberry32 PRNG (realm-native — uses only arithmetic, no host objects) ----
var _prngState = __uuidSeed__ >>> 0;
function _prngNext() {
  _prngState = (_prngState + 0x6D2B79F5) >>> 0;
  var z = _prngState;
  z = Math.imul(z ^ (z >>> 15), z | 1) >>> 0;
  z = (z ^ (z + Math.imul(z ^ (z >>> 7), z | 61) >>> 0)) >>> 0;
  return (z ^ (z >>> 14)) >>> 0;
}

// ---- Produce a 32-bit hex string (8 hex chars) from a uint32 ----
function _toHex8(n) {
  var s = (n >>> 0).toString(16);
  while (s.length < 8) s = '0' + s;
  return s;
}
function _toHex4(n) {
  var s = (n & 0xFFFF).toString(16);
  while (s.length < 4) s = '0' + s;
  return s;
}

// ---- Generate UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx ----
// Consumes 4 × 32-bit PRNG values (128 bits total), then stamps version/variant.
// Layout:
//   p1 (8 hex)  = a[31:0]          [32 bits]
//   p2 (4 hex)  = b[31:16]         [16 bits]
//   p3 (4 hex)  = '4' + b[11:0]    [version=4, 12 bits]
//   p4 (4 hex)  = variant + c[27:16] [variant=10xx, 12 bits]
//   p5 (12 hex) = c[15:0] + d[31:16] + d[15:0]  [48 bits exactly]
function _genUuid() {
  var a = _prngNext();
  var b = _prngNext();
  var c = _prngNext();
  var d = _prngNext();
  var p1 = _toHex8(a);
  var p2 = _toHex4(b >>> 16);
  var p3 = '4' + _toHex4(b & 0x0FFF).slice(0, 3);
  // variant bits: 10xx → values 8, 9, a, or b
  var variant = ((c >>> 30) & 0x1) | 0x8;
  var p4 = variant.toString(16) + _toHex4((c >>> 16) & 0x0FFF).slice(0, 3);
  // p5: exactly 48 bits = 12 hex chars: c[15:0](4) + d[31:16](4) + d[15:0](4)
  var p5 = _toHex4(c & 0xFFFF) + _toHex4(d >>> 16) + _toHex4(d & 0xFFFF);
  return p1 + '-' + p2 + '-' + p3 + '-' + p4 + '-' + p5;
}

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

// ---- Log buffer: realm-native array of primitive strings, bounded by __logBufCap__ ----
// host reads this after runInContext as plain strings — no realm function is called.
var __logBuffer__ = [];
function _pushLog(level, msg) {
  if (__logBuffer__.length >= __logBufCap__) {
    if (__logBuffer__[__logBuffer__.length - 1] !== '{"level":"truncated","msg":"[log buffer cap reached]"}') {
      __logBuffer__.push('{"level":"truncated","msg":"[log buffer cap reached]"}');
    }
    return;
  }
  var entry = '{"level":' + JSON.stringify(level) + ',"msg":' + JSON.stringify(String(msg)) + '}';
  __logBuffer__.push(entry);
}

// Override realm-native console methods with buffering versions.
console.log   = function() { _pushLog('info',  Array.prototype.join.call(arguments, ' ')); };
console.info  = function() { _pushLog('info',  Array.prototype.join.call(arguments, ' ')); };
console.warn  = function() { _pushLog('warn',  Array.prototype.join.call(arguments, ' ')); };
console.error = function() { _pushLog('error', Array.prototype.join.call(arguments, ' ')); };
console.debug = function() { _pushLog('debug', Array.prototype.join.call(arguments, ' ')); };

var _makeLogger = function(bindings) {
  return {
    info:  function(msg) { _pushLog('info',  msg); },
    warn:  function(msg) { _pushLog('warn',  msg); },
    error: function(msg) { _pushLog('error', msg); },
    debug: function(msg) { _pushLog('debug', msg); },
    child: function(b)   { return _makeLogger(b); },
  };
};
var _realmLogger = _makeLogger({});

var __ctx__ = {
  command: _ctxData.command,
  state: _ctxData.state,
  payload: _ctxData.payload,
  event: _ctxData.event,
  helpers: {
    uuid: function() { return _genUuid(); },
    now: function() { return __nowVal__; },
    deepClone: _deepClone,
    deepMerge: _deepMerge,
  },
  logger: _realmLogger,
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

    // Drain the realm log buffer into the host logger.
    // We read __logBuffer__ from the context as an array reference; each element
    // is guaranteed to be a primitive string because _pushLog only pushes
    // JSON.stringify results. We do NOT call any realm function here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawBuffer = (safeContext as any).__logBuffer__;
    if (Array.isArray(rawBuffer)) {
      const len = rawBuffer.length;
      for (let i = 0; i < len; i++) {
        const raw = rawBuffer[i];
        if (typeof raw !== 'string') continue;
        try {
          const entry = JSON.parse(raw) as { level?: string; msg?: string };
          const level = typeof entry.level === 'string' ? entry.level : 'info';
          const msg = typeof entry.msg === 'string' ? entry.msg : raw;
          if (level === 'warn') _log.warn({ source: 'reducer' }, msg);
          else if (level === 'error') _log.error({ source: 'reducer' }, msg);
          else if (level === 'debug') _log.debug({ source: 'reducer' }, msg);
          else _log.info({ source: 'reducer' }, msg);
        } catch {
          _log.info({ source: 'reducer' }, raw);
        }
      }
    }

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
