/**
 * Additional branch coverage for dsl/schema.ts
 *
 * Targets uncovered branches:
 *  - optionalString: non-string value throws
 *  - requireStringStringMap: non-object value throws; value with non-string entry throws
 *  - requireStringMixedMap: non-object value throws; value with invalid entry throws; object value serialised as JSON
 *  - validateSecondaryCommandSpec: non-object entry throws; invalid intent throws
 *  - validateBehaviorRule: match not an object throws; dispatch_commands not array throws
 *  - validateIdentityConfig: non-object identity throws; non-object identity.creation throws
 *  - validateInitialization: non-array throws; array entry not object throws
 *  - validateBoundaryConfig: query_mapping non-object throws; reducers not array throws; event_catalog not array throws
 */

import { validateBoundaryConfig } from '../../../src/dsl/schema';
import { BootError } from '../../../src/errors';

const minimalBase = {
  boundary: 'B',
  contract_path: '/b',
  behaviors: [],
  reducers: [],
  event_catalog: [],
};

const fullBase = {
  boundary: 'B',
  contract_path: '/b',
  behaviors: [
    { name: 'create', match: { operationId: 'createThing', condition: 'true' }, emit: 'Ev' },
  ],
  reducers: [{ on: 'Ev', assign: { status: '"active"' } }],
  event_catalog: [{ type: 'Ev', payload_template: {} }],
};

describe('dsl/schema — additional branch coverage', () => {
  // ── optionalString ──────────────────────────────────────────────────────────

  describe('identity.creation.generate non-string', () => {
    it('throws when identity.creation.generate is not a string', () => {
      const raw = {
        ...minimalBase,
        identity: { creation: { generate: 123 } },
      };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });
  });

  // ── requireStringStringMap ──────────────────────────────────────────────────

  describe('query_mapping validation', () => {
    it('throws when query_mapping is a string (not object)', () => {
      const raw = { ...minimalBase, query_mapping: 'bad' };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });

    it('throws when query_mapping value is not a string', () => {
      const raw = { ...minimalBase, query_mapping: { filter: 123 } };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });

    it('accepts valid string-string query_mapping', () => {
      const raw = { ...minimalBase, query_mapping: { status: 'state.status == param' } };
      const config = validateBoundaryConfig(raw);
      expect(config.queryMapping?.['status']).toBe('state.status == param');
    });
  });

  // ── requireStringMixedMap ───────────────────────────────────────────────────

  describe('reducer append validation', () => {
    it('throws when append field value is invalid (not string or object)', () => {
      const raw = {
        ...minimalBase,
        behaviors: [],
        reducers: [{ on: 'Ev', append: { list: 123 } }],
        event_catalog: [{ type: 'Ev', payload_template: {} }],
      };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });

    it('throws when append is not an object', () => {
      const raw = {
        ...minimalBase,
        behaviors: [],
        reducers: [{ on: 'Ev', append: 'not-an-object' }],
        event_catalog: [{ type: 'Ev', payload_template: {} }],
      };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });

    it('serialises object append values as JSON strings', () => {
      const raw = {
        ...minimalBase,
        behaviors: [],
        reducers: [
          { on: 'Ev', append: { list: { type: 'repayment', amount: 100 } } },
        ],
        event_catalog: [{ type: 'Ev', payload_template: {} }],
      };
      const config = validateBoundaryConfig(raw);
      const appendVal = config.reducers[0]?.append?.['list'];
      expect(typeof appendVal).toBe('string');
      expect(JSON.parse(appendVal!)).toMatchObject({ type: 'repayment', amount: 100 });
    });
  });

  // ── validateBehaviorRule ────────────────────────────────────────────────────

  describe('behavior.match validation', () => {
    it('throws when behavior.match is not an object', () => {
      const raw = {
        ...minimalBase,
        behaviors: [{ name: 'b', match: 'bad', emit: 'Ev' }],
        event_catalog: [{ type: 'Ev', payload_template: {} }],
      };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });

    it('throws when behavior.match.condition is missing', () => {
      const raw = {
        ...minimalBase,
        behaviors: [{ name: 'b', match: { intent: 'creation' }, emit: 'Ev' }],
        event_catalog: [{ type: 'Ev', payload_template: {} }],
      };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });
  });

  describe('dispatch_commands validation', () => {
    it('throws when dispatch_commands is not an array', () => {
      const raw = {
        ...minimalBase,
        behaviors: [
          {
            name: 'b',
            match: { operationId: 'createThing', condition: 'true' },
            emit: 'Ev',
            dispatch_commands: 'not-array',
          },
        ],
        event_catalog: [{ type: 'Ev', payload_template: {} }],
      };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });

    it('throws when dispatch_commands entry is not an object', () => {
      const raw = {
        ...minimalBase,
        behaviors: [
          {
            name: 'b',
            match: { operationId: 'createThing', condition: 'true' },
            emit: 'Ev',
            dispatch_commands: ['string-not-object'],
          },
        ],
        event_catalog: [{ type: 'Ev', payload_template: {} }],
      };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });

    it('throws when dispatch_commands[i].intent is invalid', () => {
      const raw = {
        ...minimalBase,
        behaviors: [
          {
            name: 'b',
            match: { operationId: 'createThing', condition: 'true' },
            emit: 'Ev',
            dispatch_commands: [
              { boundary: 'Other', intent: 'bogus', target_id: 'id-1' },
            ],
          },
        ],
        event_catalog: [{ type: 'Ev', payload_template: {} }],
      };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });

    it('accepts a valid dispatch_commands entry without payload', () => {
      const raw = {
        ...minimalBase,
        behaviors: [
          {
            name: 'b',
            match: { operationId: 'createThing', condition: 'true' },
            emit: 'Ev',
            dispatch_commands: [
              { boundary: 'Other', intent: 'mutation', operationId: 'op', target_id: '"some-id"' },
            ],
          },
        ],
        event_catalog: [{ type: 'Ev', payload_template: {} }],
      };
      const config = validateBoundaryConfig(raw);
      expect(config.behaviors[0]?.dispatchCommands).toHaveLength(1);
    });
  });

  // ── validateIdentityConfig ──────────────────────────────────────────────────

  describe('identity validation', () => {
    it('throws when identity is not an object', () => {
      const raw = { ...minimalBase, identity: 'string-identity' };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });

    it('throws when identity.creation is not an object', () => {
      const raw = { ...minimalBase, identity: { creation: 'bad' } };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });

    it('accepts identity with no creation field', () => {
      const raw = { ...minimalBase, identity: {} };
      const config = validateBoundaryConfig(raw);
      expect(config.identity).toEqual({});
    });
  });

  // ── validateInitialization ──────────────────────────────────────────────────

  describe('initialization validation', () => {
    it('throws when initialization is not an array', () => {
      const raw = { ...minimalBase, initialization: { notAnArray: true } };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });

    it('throws when initialization array contains non-object', () => {
      const raw = { ...minimalBase, initialization: ['string-not-object'] };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });

    it('accepts a valid initialization array of objects', () => {
      const raw = {
        ...minimalBase,
        initialization: [{ id: 'seed-1', name: 'Seed Entity' }],
      };
      const config = validateBoundaryConfig(raw);
      expect(config.initialization).toHaveLength(1);
    });
  });

  // ── reducers not array ──────────────────────────────────────────────────────

  describe('reducers array validation', () => {
    it('throws when reducers is not an array', () => {
      const raw = { ...minimalBase, reducers: 'not-array' };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });

    it('throws when reducer entry is not an object', () => {
      const raw = { ...minimalBase, reducers: ['string'] };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });
  });

  // ── event_catalog not array ─────────────────────────────────────────────────

  describe('event_catalog array validation', () => {
    it('throws when event_catalog is not an array', () => {
      const raw = { ...minimalBase, event_catalog: 'not-array' };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });

    it('throws when event_catalog entry is not an object', () => {
      const raw = { ...minimalBase, event_catalog: ['string'] };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
    });
  });

  // ── cross-validation (BOOT_ERR_DSL_REFERENCE) ──────────────────────────────

  describe('cross-reference validation', () => {
    it('throws BOOT_ERR_DSL_REFERENCE for reducer referencing unknown event', () => {
      const raw = {
        boundary: 'B',
        contract_path: '/b',
        behaviors: [],
        reducers: [{ on: 'UnknownEvent', assign: { x: '"y"' } }],
        event_catalog: [{ type: 'KnownEvent', payload_template: {} }],
      };
      try {
        validateBoundaryConfig(raw);
        fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(BootError);
        expect((e as BootError).code).toBe('BOOT_ERR_DSL_REFERENCE');
      }
    });
  });

  // ── snake_case → camelCase conversion ──────────────────────────────────────

  describe('camelCase conversion', () => {
    it('converts contract_path → contractPath', () => {
      const config = validateBoundaryConfig(fullBase);
      expect(config.contractPath).toBe('/b');
    });

    it('converts event_catalog → eventCatalog', () => {
      const config = validateBoundaryConfig(fullBase);
      expect(Array.isArray(config.eventCatalog)).toBe(true);
    });

    it('converts dispatch_commands → dispatchCommands in behavior', () => {
      const raw = {
        boundary: 'B',
        contract_path: '/b',
        behaviors: [
          {
            name: 'b',
            match: { operationId: 'createThing', condition: 'true' },
            emit: 'Ev',
            dispatch_commands: [
              { boundary: 'X', intent: 'mutation', operationId: 'op', target_id: '"x"' },
            ],
          },
        ],
        reducers: [],
        event_catalog: [{ type: 'Ev', payload_template: {} }],
      };
      const config = validateBoundaryConfig(raw);
      expect(config.behaviors[0]?.dispatchCommands?.[0]?.targetId).toBe('"x"');
    });
  });
});
