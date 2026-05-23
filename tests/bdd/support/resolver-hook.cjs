/**
 * Module resolver hook for Cucumber BDD tests.
 *
 * The source tree uses ESM-style `.js` import extensions (e.g. `import './foo.js'`)
 * even though the TypeScript target is CommonJS.  ts-node's CJS resolver does not
 * automatically rewrite `.js` → `.ts`, so we patch `Module._resolveFilename` here
 * to strip the `.js` extension for relative imports, allowing ts-node to locate
 * the corresponding `.ts` source file.
 *
 * This file is loaded via --require before ts-node/register.
 */
'use strict';

const Module = require('module');
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function patchedResolveFilename(request, parent, isMain, options) {
  if (
    typeof request === 'string' &&
    request.startsWith('.') &&
    request.endsWith('.js')
  ) {
    const stripped = request.slice(0, -3);
    try {
      return originalResolveFilename.call(this, stripped, parent, isMain, options);
    } catch (_) {
      // fall through to original resolution
    }
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};
