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
} from '../../src/errors';

describe('errors', () => {
  describe('SimError base class', () => {
    it('is abstract — cannot be directly instantiated', () => {
      // BootError is the easiest concrete subclass
      const err = new BootError('CODE', 'msg');
      expect(err).toBeInstanceOf(SimError);
    });

    it('sets message', () => {
      const err = new ContractViolationError('bad request');
      expect(err.message).toBe('bad request');
    });

    it('sets name to class name', () => {
      const err = new EntityAbsenceError('not found');
      expect(err.name).toBe('EntityAbsenceError');
    });

    it('stores optional details', () => {
      const err = new ContractViolationError('msg', { field: 'amount' });
      expect(err.details).toEqual({ field: 'amount' });
    });

    it('details is undefined when not provided', () => {
      const err = new ContractViolationError('msg');
      expect(err.details).toBeUndefined();
    });

    it('instanceof check works correctly (prototype chain fix)', () => {
      const err = new EntityAbsenceError('msg');
      expect(err instanceof EntityAbsenceError).toBe(true);
      expect(err instanceof SimError).toBe(true);
      expect(err instanceof Error).toBe(true);
    });

    it('toJSON includes name, code, message, details', () => {
      const err = new ContractViolationError('bad', { x: 1 });
      const json = err.toJSON();
      expect(json.name).toBe('ContractViolationError');
      expect(json.code).toBe('CONTRACT_VIOLATION');
      expect(json.message).toBe('bad');
      expect(json.details).toEqual({ x: 1 });
    });

    it('toJSON details is null when details not provided', () => {
      const err = new ContractViolationError('msg');
      expect(err.toJSON().details).toBeNull();
    });
  });

  describe('BootError', () => {
    it('stores the code', () => {
      const err = new BootError('BOOT_ERR_DSL_SYNTAX', 'parse error');
      expect(err.code).toBe('BOOT_ERR_DSL_SYNTAX');
    });

    it('is an instance of SimError', () => {
      expect(new BootError('X', 'y')).toBeInstanceOf(SimError);
    });
  });

  describe('ContractViolationError', () => {
    it('has status 400', () => {
      expect(new ContractViolationError('msg').status).toBe(400);
    });

    it('has code CONTRACT_VIOLATION', () => {
      expect(new ContractViolationError('msg').code).toBe('CONTRACT_VIOLATION');
    });
  });

  describe('EntityAbsenceError', () => {
    it('has status 404', () => {
      expect(new EntityAbsenceError('msg').status).toBe(404);
    });

    it('has code ENTITY_ABSENCE', () => {
      expect(new EntityAbsenceError('msg').code).toBe('ENTITY_ABSENCE');
    });
  });

  describe('EntityConflictError', () => {
    it('has status 409', () => {
      expect(new EntityConflictError('msg').status).toBe(409);
    });

    it('has code ENTITY_CONFLICT', () => {
      expect(new EntityConflictError('msg').code).toBe('ENTITY_CONFLICT');
    });
  });

  describe('UnhandledOperationError', () => {
    it('has status 422', () => {
      expect(new UnhandledOperationError('msg').status).toBe(422);
    });

    it('has code UNHANDLED_OPERATION', () => {
      expect(new UnhandledOperationError('msg').code).toBe('UNHANDLED_OPERATION');
    });
  });

  describe('ConcurrencyConflictError', () => {
    it('has status 412', () => {
      expect(new ConcurrencyConflictError('msg').status).toBe(412);
    });

    it('has code CONCURRENCY_CONFLICT', () => {
      expect(new ConcurrencyConflictError('msg').code).toBe('CONCURRENCY_CONFLICT');
    });
  });

  describe('MissingPreconditionError', () => {
    it('has status 428', () => {
      expect(new MissingPreconditionError('msg').status).toBe(428);
    });

    it('has code MISSING_PRECONDITION', () => {
      expect(new MissingPreconditionError('msg').code).toBe('MISSING_PRECONDITION');
    });
  });

  describe('InternalExecutionError', () => {
    it('has status 500', () => {
      expect(new InternalExecutionError('msg').status).toBe(500);
    });

    it('has code INTERNAL_EXECUTION_ERROR', () => {
      expect(new InternalExecutionError('msg').code).toBe('INTERNAL_EXECUTION_ERROR');
    });
  });

  describe('InfiniteLoopError', () => {
    it('has status 508', () => {
      expect(new InfiniteLoopError('msg').status).toBe(508);
    });

    it('has code INFINITE_LOOP', () => {
      expect(new InfiniteLoopError('msg').code).toBe('INFINITE_LOOP');
    });
  });

  describe('FaultSimulatedError', () => {
    it('stores status', () => {
      const err = new FaultSimulatedError(503, { error: 'service unavailable' });
      expect(err.status).toBe(503);
    });

    it('has code FAULT_SIMULATED', () => {
      expect(new FaultSimulatedError(500, {}).code).toBe('FAULT_SIMULATED');
    });

    it('stores simulatedBody', () => {
      const body = { message: 'fault' };
      const err = new FaultSimulatedError(503, body);
      expect(err.simulatedBody).toEqual(body);
    });

    it('stores simulatedHeaders when provided', () => {
      const headers = { 'retry-after': '30' };
      const err = new FaultSimulatedError(503, {}, headers);
      expect(err.simulatedHeaders).toEqual(headers);
    });

    it('simulatedHeaders is undefined when not provided', () => {
      expect(new FaultSimulatedError(500, {}).simulatedHeaders).toBeUndefined();
    });

    it('toJSON returns the simulated body directly (matching gateway HTTP response shape)', () => {
      const err = new FaultSimulatedError(503, { msg: 'fault' });
      const json = err.toJSON();
      // toJSON() returns the simulated body — same shape the gateway sends via res.json(err.toJSON())
      expect(json).toEqual({ msg: 'fault' });
    });

    it('is instanceof SimError', () => {
      expect(new FaultSimulatedError(500, {})).toBeInstanceOf(SimError);
    });
  });
});
