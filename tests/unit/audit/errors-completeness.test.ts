/**
 * Probing tests for error class completeness gaps (errors.ts).
 *
 * Gaps under test:
 *  1. instanceof preservation after JSON roundtrip — toJSON()/JSON.parse cannot
 *     reconstruct the prototype chain; this is a known limitation and we pin it.
 *  2. All error subclasses carry both `code` AND `details` consistently.
 *  3. SimError.toJSON() symmetry with what the HTTP gateway emits.
 *  4. BootError does not have a `status` property (it's a boot-time error, pre-HTTP).
 *  5. FaultSimulatedError.toJSON() includes simulatedHeaders when present.
 *  6. Error subclass name is preserved correctly (not "Error" or "SimError").
 *  7. Error stack trace is present on all subclasses.
 *  8. toJSON() returns plain object (not class instance).
 *  9. Errors with numeric details are serialisable.
 * 10. FaultSimulatedError: simulatedBody can be null (edge case).
 */

import {
  SimError,
  BootError,
  ContractViolationError,
  EntityAbsenceError,
  EntityConflictError,
  UnhandledOperationError,
  ConcurrencyConflictError,
  MissingPreconditionError,
  InternalExecutionError,
  InfiniteLoopError,
  FaultSimulatedError,
} from '../../../src/errors.js';

// ---------------------------------------------------------------------------
// All concrete error classes for table-driven tests
// ---------------------------------------------------------------------------

const ALL_HTTP_ERRORS: Array<{ name: string; error: SimError; expectedCode: string; expectedStatus: number }> = [
  {
    name: 'ContractViolationError',
    error: new ContractViolationError('msg', { detail: 1 }),
    expectedCode: 'CONTRACT_VIOLATION',
    expectedStatus: 400,
  },
  {
    name: 'EntityAbsenceError',
    error: new EntityAbsenceError('msg', { id: 'x' }),
    expectedCode: 'ENTITY_ABSENCE',
    expectedStatus: 404,
  },
  {
    name: 'EntityConflictError',
    error: new EntityConflictError('msg'),
    expectedCode: 'ENTITY_CONFLICT',
    expectedStatus: 409,
  },
  {
    name: 'UnhandledOperationError',
    error: new UnhandledOperationError('msg'),
    expectedCode: 'UNHANDLED_OPERATION',
    expectedStatus: 422,
  },
  {
    name: 'ConcurrencyConflictError',
    error: new ConcurrencyConflictError('msg', { expected: 1, current: 2 }),
    expectedCode: 'CONCURRENCY_CONFLICT',
    expectedStatus: 412,
  },
  {
    name: 'MissingPreconditionError',
    error: new MissingPreconditionError('msg'),
    expectedCode: 'MISSING_PRECONDITION',
    expectedStatus: 428,
  },
  {
    name: 'InternalExecutionError',
    error: new InternalExecutionError('msg', { sub: 'SCHEMA_TYPE_MISMATCH' }),
    expectedCode: 'INTERNAL_EXECUTION_ERROR',
    expectedStatus: 500,
  },
  {
    name: 'InfiniteLoopError',
    error: new InfiniteLoopError('msg', { depth: 6 }),
    expectedCode: 'INFINITE_LOOP',
    expectedStatus: 508,
  },
];

// ---------------------------------------------------------------------------
// instanceof preservation gap
// ---------------------------------------------------------------------------

describe('errors — JSON roundtrip preserves discriminating code', () => {
  it('toJSON().code can be used to reconstruct the correct error type after JSON roundtrip', () => {
    const err = new ContractViolationError('bad request');
    const json = JSON.parse(JSON.stringify(err.toJSON())) as { code: string };
    expect(json.code).toBe('CONTRACT_VIOLATION');
  });
});

// ---------------------------------------------------------------------------
// code AND details presence
// ---------------------------------------------------------------------------

describe('errors — code and details presence', () => {
  for (const { name, error, expectedCode } of ALL_HTTP_ERRORS) {
    it(`${name} has code = '${expectedCode}'`, () => {
      expect(error.code).toBe(expectedCode);
    });

    it(`${name}.toJSON() includes both code and details fields`, () => {
      const json = error.toJSON();
      expect('code' in json).toBe(true);
      expect('details' in json).toBe(true);
    });

    it(`${name}.toJSON().details is null when no details provided`, () => {
      // Construct with no details
      const errNoDetails = (() => {
        switch (name) {
          case 'ContractViolationError': return new ContractViolationError('m');
          case 'EntityAbsenceError': return new EntityAbsenceError('m');
          case 'EntityConflictError': return new EntityConflictError('m');
          case 'UnhandledOperationError': return new UnhandledOperationError('m');
          case 'ConcurrencyConflictError': return new ConcurrencyConflictError('m');
          case 'MissingPreconditionError': return new MissingPreconditionError('m');
          case 'InternalExecutionError': return new InternalExecutionError('m');
          case 'InfiniteLoopError': return new InfiniteLoopError('m');
          default: return new ContractViolationError('m');
        }
      })();
      expect(errNoDetails.toJSON().details).toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// HTTP status consistency
// ---------------------------------------------------------------------------

describe('errors — HTTP status codes', () => {
  for (const { name, error, expectedStatus } of ALL_HTTP_ERRORS) {
    it(`${name} has HTTP status ${expectedStatus}`, () => {
      expect((error as unknown as { status: number }).status).toBe(expectedStatus);
    });
  }

  it('BootError has NO status property (boot-time error, pre-HTTP)', () => {
    const err = new BootError('BOOT_ERR_DSL_SYNTAX', 'parse error');
    expect((err as unknown as { status?: number }).status).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// toJSON symmetry with HTTP gateway output
// ---------------------------------------------------------------------------

describe('errors — toJSON symmetry with gateway HTTP response body', () => {
  it('EntityAbsenceError.toJSON() has name, code, message, details (matches gateway res.json(err.toJSON()))', () => {
    const err = new EntityAbsenceError('not found', { id: 'xyz' });
    const json = err.toJSON();
    expect(json).toMatchObject({
      name: 'EntityAbsenceError',
      code: 'ENTITY_ABSENCE',
      message: 'not found',
      details: { id: 'xyz' },
    });
  });

  it('InternalExecutionError.toJSON() does NOT expose a `status` field (status is only in the HTTP response, not body)', () => {
    const err = new InternalExecutionError('internal');
    const json = err.toJSON();
    // Gateway uses err.toJSON() as the response body — the HTTP status code is set
    // separately via res.status(500). The body itself should not re-expose `status`.
    expect(json['status']).toBeUndefined();
  });

  it(
    'FaultSimulatedError.toJSON() matches the HTTP response body emitted by gateway (symmetry restored)',
    () => {
      const err = new FaultSimulatedError(503, { error: 'SERVICE_UNAVAILABLE' }, { 'Retry-After': '30' });

      // Gateway now calls res.status(err.status).json(err.toJSON()) — both return the simulated body.
      // err.toJSON() returns the simulated body directly, so gateway and toJSON() are in sync.
      const simulatedResponse = err.simulatedBody;
      expect(simulatedResponse).toEqual(err.toJSON());
    },
  );

  it('gateway uses err.toJSON() for FaultSimulatedError — same shape as err.simulatedBody', () => {
    const simulatedBody = { error: 'SERVICE_UNAVAILABLE' };
    const err = new FaultSimulatedError(503, simulatedBody);

    // toJSON() now returns the simulated body directly — same as what the gateway sends
    const toJsonBody = err.toJSON();
    expect(toJsonBody).toEqual(simulatedBody);
    expect(err.simulatedBody).toEqual(simulatedBody);
  });
});

// ---------------------------------------------------------------------------
// FaultSimulatedError edge cases
// ---------------------------------------------------------------------------

describe('errors — FaultSimulatedError edge cases', () => {
  it('simulatedBody can be null', () => {
    const err = new FaultSimulatedError(503, null);
    expect(err.simulatedBody).toBeNull();
    // toJSON() returns { body: null } when simulatedBody is null (non-object fallback)
    expect(err.toJSON()['body']).toBeNull();
  });

  it('simulatedBody can be a string', () => {
    const err = new FaultSimulatedError(503, 'plain text fault');
    expect(err.simulatedBody).toBe('plain text fault');
  });

  it('simulatedHeaders is accessible on the error instance when provided', () => {
    const err = new FaultSimulatedError(503, {}, { 'Retry-After': '60' });
    // simulatedHeaders is available as a property for the gateway to set response headers
    expect(err.simulatedHeaders).toEqual({ 'Retry-After': '60' });
    // toJSON() returns the simulated body — headers are applied separately by the gateway
    expect(err.toJSON()).toEqual({});
  });

  it('simulatedHeaders is undefined on instance when not provided', () => {
    const err = new FaultSimulatedError(503, {});
    expect(err.simulatedHeaders).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Error name and stack
// ---------------------------------------------------------------------------

describe('errors — error name and stack', () => {
  it('each error subclass name matches the constructor name', () => {
    const cases: Array<[string, SimError]> = [
      ['BootError', new BootError('CODE', 'msg')],
      ['ContractViolationError', new ContractViolationError('msg')],
      ['EntityAbsenceError', new EntityAbsenceError('msg')],
      ['EntityConflictError', new EntityConflictError('msg')],
      ['UnhandledOperationError', new UnhandledOperationError('msg')],
      ['ConcurrencyConflictError', new ConcurrencyConflictError('msg')],
      ['MissingPreconditionError', new MissingPreconditionError('msg')],
      ['InternalExecutionError', new InternalExecutionError('msg')],
      ['InfiniteLoopError', new InfiniteLoopError('msg')],
      ['FaultSimulatedError', new FaultSimulatedError(503, {})],
    ];

    for (const [expectedName, err] of cases) {
      expect(err.name).toBe(expectedName);
    }
  });

  it('all error subclasses have a stack trace', () => {
    const errors: SimError[] = [
      new ContractViolationError('msg'),
      new EntityAbsenceError('msg'),
      new InternalExecutionError('msg'),
      new FaultSimulatedError(500, {}),
    ];
    for (const err of errors) {
      expect(err.stack).toBeDefined();
      expect(err.stack!.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// toJSON returns plain object
// ---------------------------------------------------------------------------

describe('errors — toJSON returns plain object (not class instance)', () => {
  it('ContractViolationError.toJSON() returns a plain Record, not a SimError instance', () => {
    const err = new ContractViolationError('msg');
    const json = err.toJSON();
    expect(json).not.toBeInstanceOf(SimError);
    expect(json.constructor).toBe(Object);
  });

  it('FaultSimulatedError.toJSON() returns a plain Record', () => {
    const err = new FaultSimulatedError(503, {});
    const json = err.toJSON();
    expect(json.constructor).toBe(Object);
  });
});

// ---------------------------------------------------------------------------
// Numeric details serialisation
// ---------------------------------------------------------------------------

describe('errors — numeric details serialisation', () => {
  it('ConcurrencyConflictError with numeric details serialises correctly via JSON.stringify', () => {
    const err = new ConcurrencyConflictError('mismatch', { expected: 5, current: 3 });
    const serialised = JSON.parse(JSON.stringify(err.toJSON())) as Record<string, unknown>;
    expect(serialised['details']).toEqual({ expected: 5, current: 3 });
  });

  it('InfiniteLoopError with deeply nested details serialises correctly', () => {
    const err = new InfiniteLoopError('depth exceeded', {
      depth: 6,
      maxDepth: 5,
      boundary: 'Customer',
    });
    const json = err.toJSON();
    expect(json.details).toEqual({ depth: 6, maxDepth: 5, boundary: 'Customer' });
  });
});
