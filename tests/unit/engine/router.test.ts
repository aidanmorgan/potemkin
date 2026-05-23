import { translateIntent } from '../../../src/engine/router';
import { ContractViolationError } from '../../../src/errors';
import { makeBoundary } from '../_helpers';

describe('engine/router', () => {
  describe('translateIntent', () => {
    it('GET -> query', () => {
      expect(translateIntent({ method: 'GET', boundary: makeBoundary() })).toBe('query');
    });

    it('get (lowercase) -> query', () => {
      expect(translateIntent({ method: 'get', boundary: makeBoundary() })).toBe('query');
    });

    it('POST with identity.creation -> creation', () => {
      const boundary = makeBoundary({ identity: { creation: { generate: '$uuidv7()' } } });
      expect(translateIntent({ method: 'POST', boundary })).toBe('creation');
    });

    it('POST without identity.creation -> mutation', () => {
      expect(translateIntent({ method: 'POST', boundary: makeBoundary() })).toBe('mutation');
    });

    it('POST with identity but no creation property -> mutation', () => {
      const boundary = makeBoundary({ identity: {} });
      expect(translateIntent({ method: 'POST', boundary })).toBe('mutation');
    });

    it('PUT -> mutation', () => {
      expect(translateIntent({ method: 'PUT', boundary: makeBoundary() })).toBe('mutation');
    });

    it('PATCH -> mutation', () => {
      expect(translateIntent({ method: 'PATCH', boundary: makeBoundary() })).toBe('mutation');
    });

    it('DELETE -> mutation', () => {
      expect(translateIntent({ method: 'DELETE', boundary: makeBoundary() })).toBe('mutation');
    });

    it('put (lowercase) -> mutation', () => {
      expect(translateIntent({ method: 'put', boundary: makeBoundary() })).toBe('mutation');
    });

    it('unknown method throws ContractViolationError', () => {
      expect(() =>
        translateIntent({ method: 'CONNECT', boundary: makeBoundary() }),
      ).toThrow(ContractViolationError);
    });

    it('OPTIONS method throws ContractViolationError', () => {
      expect(() =>
        translateIntent({ method: 'OPTIONS', boundary: makeBoundary() }),
      ).toThrow(ContractViolationError);
    });

    it('HEAD method throws ContractViolationError', () => {
      expect(() =>
        translateIntent({ method: 'HEAD', boundary: makeBoundary() }),
      ).toThrow(ContractViolationError);
    });

    it('error message includes the method name', () => {
      try {
        translateIntent({ method: 'BADMETHOD', boundary: makeBoundary() });
      } catch (e) {
        expect((e as Error).message).toContain('BADMETHOD');
      }
    });
  });
});
