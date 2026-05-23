/**
 * Property-based tests for DSL schema enforcement.
 *
 * Tests:
 *  - Paths NOT in schema → staticCheckDsl / guardAssignPath flags them
 *  - Paths IN schema → pass validation
 *  - Mismatched types at runtime → SCHEMA_TYPE_MISMATCH
 */

import * as fc from 'fast-check';
import { guardAssignPath, guardAssignedValue } from '../../src/schema/runtimeGuard';
import { pathExists } from '../../src/schema/pathResolver';
import { makeBankingRegistry, CUSTOMER_SCHEMA } from './_helpers/fixtures';
import { InternalExecutionError } from '../../src/errors';

const RUN_COUNT = 200;
const SEED = 42;

const registry = makeBankingRegistry();
const BOUNDARY = 'Customer';

// ---------------------------------------------------------------------------
// Known valid paths for Customer boundary
// ---------------------------------------------------------------------------

const VALID_PATHS = [
  'customerId',
  'name',
  'email',
  'balance',
  'active',
  'tags',
  'address',
  'address.street',
  'address.city',
];

// ---------------------------------------------------------------------------
// Generators for invalid paths (not in schema)
// ---------------------------------------------------------------------------

// Keys inherited from Object.prototype that pathResolver incorrectly treats as valid
// (this is a known bug — see it.failing test below)
const PROTOTYPE_KEYS = new Set(Object.getOwnPropertyNames(Object.prototype));

const arbInvalidPath = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter(
    (s) =>
      !VALID_PATHS.includes(s) &&
      !s.startsWith('address.') &&
      /^[a-zA-Z][a-zA-Z0-9_.]*$/.test(s) &&
      s !== '__proto__' &&
      s !== 'constructor' &&
      // Exclude prototype-inherited keys due to known bug in pathResolver (see it.failing test)
      !PROTOTYPE_KEYS.has(s),
  )
  .filter((s) => !VALID_PATHS.some((vp) => s === vp));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Schema enforcement properties', () => {
  // P1: Every path NOT in schema causes guardAssignPath to throw
  it('guardAssignPath throws SCHEMA_PATH_UNKNOWN for paths not in schema', () => {
    fc.assert(
      fc.property(arbInvalidPath, (path) => {
        // Double-check the path is genuinely not in schema
        fc.pre(!pathExists(registry, BOUNDARY, path));

        expect(() => {
          guardAssignPath(registry, BOUNDARY, path);
        }).toThrow(InternalExecutionError);
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P2: Every path that IS in schema passes guardAssignPath
  it('guardAssignPath does NOT throw for paths in schema', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_PATHS), (path) => {
        expect(() => {
          guardAssignPath(registry, BOUNDARY, path);
        }).not.toThrow();
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P3: pathExists returns false for unknown paths
  it('pathExists returns false for paths not in schema', () => {
    fc.assert(
      fc.property(arbInvalidPath, (path) => {
        const exists = pathExists(registry, BOUNDARY, path);
        expect(exists).toBe(false);
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  // P4: pathExists returns true for known valid paths
  it('pathExists returns true for all valid schema paths', () => {
    for (const path of VALID_PATHS) {
      expect(pathExists(registry, BOUNDARY, path)).toBe(true);
    }
  });

  // P5: Mismatched value type causes SCHEMA_TYPE_MISMATCH
  it('guardAssignedValue throws SCHEMA_TYPE_MISMATCH for wrong types on string path', () => {
    fc.assert(
      fc.property(
        // Non-string, non-null values that don't match string schema
        fc.oneof(fc.integer(), fc.boolean()),
        (value) => {
          expect(() => {
            // 'name' expects a string
            guardAssignedValue(registry, BOUNDARY, 'name', value);
          }).toThrow(InternalExecutionError);
        },
      ),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  it('guardAssignedValue does NOT throw for correct type on string path', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        expect(() => {
          guardAssignedValue(registry, BOUNDARY, 'name', value);
        }).not.toThrow();
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  it('guardAssignedValue throws SCHEMA_TYPE_MISMATCH for wrong types on number path', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.boolean()),
        (value) => {
          expect(() => {
            // 'balance' expects a number
            guardAssignedValue(registry, BOUNDARY, 'balance', value);
          }).toThrow(InternalExecutionError);
        },
      ),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  it('guardAssignedValue does NOT throw for correct type on number path', () => {
    fc.assert(
      fc.property(fc.float({ noNaN: true }), (value) => {
        expect(() => {
          guardAssignedValue(registry, BOUNDARY, 'balance', value);
        }).not.toThrow();
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  it('guardAssignedValue throws SCHEMA_TYPE_MISMATCH for wrong types on boolean path', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.integer()),
        (value) => {
          expect(() => {
            // 'active' expects a boolean
            guardAssignedValue(registry, BOUNDARY, 'active', value);
          }).toThrow(InternalExecutionError);
        },
      ),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });

  it('pathExists returns false for Object.prototype inherited keys', () => {
    const prototypeKeys = ['valueOf', 'toString', 'hasOwnProperty', 'isPrototypeOf'];
    for (const key of prototypeKeys) {
      expect(pathExists(registry, BOUNDARY, key)).toBe(false);
    }
  });

  // P6: Unknown boundary causes SCHEMA_PATH_UNKNOWN
  it('guardAssignPath throws for unknown boundary', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_PATHS), (path) => {
        expect(() => {
          guardAssignPath(registry, 'NonExistentBoundary', path);
        }).toThrow(InternalExecutionError);
      }),
      { numRuns: RUN_COUNT, seed: SEED },
    );
  });
});
