import { validateBoundaryConfig } from '../../../src/dsl/schema';
import { BootError } from '../../../src/errors';

const minimalValid = {
  boundary: 'MyBoundary',
  contract_path: '/my/path',
  behaviors: [
    {
      name: 'create',
      match: { operationId: 'createThing', condition: 'true' },
      emit: 'Created',
    },
  ],
  reducers: [{ on: 'Created', assign: { status: '"active"' } }],
  event_catalog: [{ type: 'Created', payload_template: {} }],
};

describe('dsl/schema', () => {
  describe('validateBoundaryConfig', () => {
    it('returns a valid BoundaryConfig for a minimal valid raw object', () => {
      const config = validateBoundaryConfig(minimalValid);
      expect(config.boundary).toBe('MyBoundary');
      expect(config.contractPath).toBe('/my/path');
    });

    it('throws BootError when input is null', () => {
      expect(() => validateBoundaryConfig(null)).toThrow(BootError);
    });

    it('throws BootError when input is not an object', () => {
      expect(() => validateBoundaryConfig('string')).toThrow(BootError);
    });

    it('throws BootError when input is an array', () => {
      expect(() => validateBoundaryConfig([])).toThrow(BootError);
    });

    it('throws BootError when boundary is missing', () => {
      const raw = { ...minimalValid, boundary: undefined };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });

    it('throws BootError when boundary is empty string', () => {
      const raw = { ...minimalValid, boundary: '' };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });

    it('throws BootError when contract_path is missing', () => {
      const raw = { ...minimalValid, contract_path: undefined };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });

    it('throws BootError for non-boolean fallback_override', () => {
      const raw = { ...minimalValid, fallback_override: 'yes' };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });

    it('accepts fallback_override: true', () => {
      const raw = { ...minimalValid, fallback_override: true };
      const config = validateBoundaryConfig(raw);
      expect(config.fallbackOverride).toBe(true);
    });

    it('defaults fallback_override to false when absent', () => {
      const config = validateBoundaryConfig(minimalValid);
      expect(config.fallbackOverride).toBe(false);
    });

    it('throws BootError when behaviors is not an array', () => {
      const raw = { ...minimalValid, behaviors: 'not-array' };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });

    it('throws BootError when behavior entry is not an object', () => {
      const raw = { ...minimalValid, behaviors: ['string'] };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });

    it('throws BootError when behavior.name is missing', () => {
      const raw = {
        ...minimalValid,
        behaviors: [{ match: { operationId: 'createThing', condition: 'true' }, emit: 'Created' }],
      };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });

    it('throws BootError when behavior.match.intent is invalid', () => {
      const raw = {
        ...minimalValid,
        behaviors: [{ name: 'b', match: { intent: 'invalid', condition: 'true' }, emit: 'Created' }],
      };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });

    it('throws BootError when reducer.on references unknown event type', () => {
      const raw = {
        ...minimalValid,
        reducers: [{ on: 'UnknownEvent' }],
      };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });

    it('throws BootError when behavior.emit references unknown event type', () => {
      const raw = {
        ...minimalValid,
        behaviors: [
          {
            name: 'b',
            match: { operationId: 'createThing', condition: 'true' },
            emit: 'UnknownEvent',
          },
        ],
      };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });

    it('parses identity.creation.generate expression', () => {
      const raw = {
        ...minimalValid,
        identity: { creation: { generate: '$uuidv7()' } },
      };
      const config = validateBoundaryConfig(raw);
      expect(config.identity?.creation?.generate).toBe('$uuidv7()');
    });

    it('handles empty arrays for behaviors, reducers, eventCatalog', () => {
      const raw = {
        boundary: 'B',
        contract_path: '/b',
        behaviors: [],
        reducers: [],
        event_catalog: [],
      };
      const config = validateBoundaryConfig(raw);
      expect(config.behaviors).toHaveLength(0);
    });

    it('parses reducer assign and append correctly', () => {
      const raw = {
        boundary: 'B',
        contract_path: '/b',
        behaviors: [],
        reducers: [{ on: 'Ev', assign: { field: '"val"' }, append: { list: '"item"' } }],
        event_catalog: [{ type: 'Ev', payload_template: {} }],
      };
      const config = validateBoundaryConfig(raw);
      expect(config.reducers[0]?.assign?.['field']).toBe('"val"');
      expect(config.reducers[0]?.append?.['list']).toBe('"item"');
    });

    it('throws BootError for BOOT_ERR_DSL_SYNTAX code on invalid input', () => {
      try {
        validateBoundaryConfig(null);
      } catch (e) {
        expect(e).toBeInstanceOf(BootError);
        expect((e as BootError).code).toBe('BOOT_ERR_DSL_SYNTAX');
      }
    });
  });
});
