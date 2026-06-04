/**
 * Exhaustive permutation tests for DSL schema validator.
 * Targets: src/dsl/schema.ts (branches ~97% → ≥95%, currently at 96.7%)
 */
import { validateBoundaryConfig } from '../../../src/dsl/schema';
import { BootError } from '../../../src/errors';

// ── Minimal valid config ──────────────────────────────────────────────────────

function minimalValid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    boundary: 'TestBoundary',
    contract_path: '/test',
    event_catalog: [{ type: 'Created', payload_template: {} }],
    behaviors: [
      {
        name: 'create',
        match: { operationId: 'createThing', condition: 'true' },
        emit: 'Created',
      },
    ],
    reducers: [],
    ...overrides,
  };
}

describe('dsl/schema — permutations', () => {
  // ── Root-level required fields ─────────────────────────────────────────────
  describe('root required fields', () => {
    it('throws when boundary is missing', () => {
      expect(() => validateBoundaryConfig({ contract_path: '/test' })).toThrow(BootError);
    });

    it('throws when boundary is empty string', () => {
      expect(() => validateBoundaryConfig({ boundary: '', contract_path: '/test' })).toThrow(BootError);
    });

    it('throws when contract_path is missing', () => {
      expect(() => validateBoundaryConfig({ boundary: 'B' })).toThrow(BootError);
    });

    it('throws when root is not an object', () => {
      expect(() => validateBoundaryConfig('not-an-object')).toThrow(BootError);
    });

    it('throws when root is null', () => {
      expect(() => validateBoundaryConfig(null)).toThrow(BootError);
    });

    it('throws when root is an array', () => {
      expect(() => validateBoundaryConfig([])).toThrow(BootError);
    });
  });

  // ── fallback_override field ────────────────────────────────────────────────
  describe('fallback_override field', () => {
    it('defaults to false when absent', () => {
      const result = validateBoundaryConfig(minimalValid());
      expect(result.fallbackOverride).toBe(false);
    });

    it('accepts true', () => {
      const result = validateBoundaryConfig(minimalValid({ fallback_override: true }));
      expect(result.fallbackOverride).toBe(true);
    });

    it('throws when fallback_override is a string', () => {
      expect(() =>
        validateBoundaryConfig(minimalValid({ fallback_override: 'yes' })),
      ).toThrow(BootError);
    });

    it('throws when fallback_override is a number', () => {
      expect(() =>
        validateBoundaryConfig(minimalValid({ fallback_override: 1 })),
      ).toThrow(BootError);
    });

    it('accepts null (treated as absent → false)', () => {
      const result = validateBoundaryConfig(minimalValid({ fallback_override: null }));
      expect(result.fallbackOverride).toBe(false);
    });
  });

  // ── identity config ────────────────────────────────────────────────────────
  describe('identity config', () => {
    it('parses identity.creation.generate', () => {
      const result = validateBoundaryConfig(minimalValid({
        identity: { creation: { generate: '$uuidv7()' } },
      }));
      expect(result.identity?.creation?.generate).toBe('$uuidv7()');
    });

    it('identity config without generate is valid', () => {
      const result = validateBoundaryConfig(minimalValid({
        identity: { creation: {} },
      }));
      expect(result.identity).toBeDefined();
    });

    it('identity config with no creation key is valid', () => {
      const result = validateBoundaryConfig(minimalValid({
        identity: {},
      }));
      expect(result.identity).toBeDefined();
    });

    it('throws when identity is not an object', () => {
      expect(() =>
        validateBoundaryConfig(minimalValid({ identity: 'bad' })),
      ).toThrow(BootError);
    });

    it('throws when identity.creation is not an object', () => {
      expect(() =>
        validateBoundaryConfig(minimalValid({ identity: { creation: 'bad' } })),
      ).toThrow(BootError);
    });

    it('throws when generate is not a string', () => {
      expect(() =>
        validateBoundaryConfig(minimalValid({ identity: { creation: { generate: 123 } } })),
      ).toThrow(BootError);
    });

    it('any string value for generate is accepted (convention only)', () => {
      const result = validateBoundaryConfig(minimalValid({
        identity: { creation: { generate: 'custom-function()' } },
      }));
      expect(result.identity?.creation?.generate).toBe('custom-function()');
    });
  });

  // ── behaviors array ────────────────────────────────────────────────────────
  describe('behaviors array', () => {
    it('empty behaviors array is valid', () => {
      const result = validateBoundaryConfig({
        boundary: 'B',
        contract_path: '/b',
        behaviors: [],
        reducers: [],
        event_catalog: [],
      });
      expect(result.behaviors).toHaveLength(0);
    });

    it('throws when behaviors is not an array', () => {
      expect(() =>
        validateBoundaryConfig(minimalValid({ behaviors: 'not-array' })),
      ).toThrow(BootError);
    });

    it('throws when a behavior is not an object', () => {
      expect(() =>
        validateBoundaryConfig(minimalValid({ behaviors: ['bad'] })),
      ).toThrow(BootError);
    });

    it('throws when behavior name is missing', () => {
      expect(() =>
        validateBoundaryConfig(minimalValid({
          behaviors: [{ match: { operationId: 'createThing', condition: 'true' }, emit: 'Created' }],
        })),
      ).toThrow(BootError);
    });

    it('throws when match is not an object', () => {
      expect(() =>
        validateBoundaryConfig(minimalValid({
          behaviors: [{ name: 'b', match: 'bad', emit: 'Created' }],
        })),
      ).toThrow(BootError);
    });

    it.each(['creation', 'mutation', 'query', 'invalid'])(
      'throws BOOT_ERR_DSL_SYNTAX when behavior declares removed match.intent "%s"',
      (intent) => {
        expect(() =>
          validateBoundaryConfig(minimalValid({
            behaviors: [{ name: 'b', match: { intent, condition: 'true' }, emit: 'Created' }],
          })),
        ).toThrow(BootError);
      },
    );

    it.each(['createB', 'updateB', 'getB'])(
      'accepts any operationId "%s"',
      (operationId) => {
        const cfg = {
          boundary: 'B',
          contract_path: '/b',
          event_catalog: [{ type: 'Ev', payload_template: {} }],
          behaviors: [{ name: 'b', match: { operationId, condition: 'true' }, emit: 'Ev' }],
          reducers: [],
        };
        expect(() => validateBoundaryConfig(cfg)).not.toThrow();
      },
    );

    it('throws when emit is missing', () => {
      expect(() =>
        validateBoundaryConfig(minimalValid({
          behaviors: [{ name: 'b', match: { operationId: 'createThing', condition: 'true' } }],
        })),
      ).toThrow(BootError);
    });
  });

  // ── dispatch_commands in behaviors ─────────────────────────────────────────
  describe('dispatch_commands in behaviors', () => {
    it('accepts behavior with dispatch_commands', () => {
      const cfg = minimalValid({
        event_catalog: [{ type: 'Created', payload_template: {} }],
        behaviors: [{
          name: 'create',
          match: { operationId: 'createThing', condition: 'true' },
          emit: 'Created',
          dispatch_commands: [{
            boundary: 'Other',
            intent: 'mutation',
            operationId: 'op',
            target_id: 'command.targetId',
          }],
        }],
      });
      const result = validateBoundaryConfig(cfg);
      expect(result.behaviors[0]?.dispatchCommands).toHaveLength(1);
    });

    it('throws when dispatch_commands is not an array', () => {
      expect(() =>
        validateBoundaryConfig(minimalValid({
          behaviors: [{
            name: 'b',
            match: { operationId: 'createThing', condition: 'true' },
            emit: 'Created',
            dispatch_commands: 'bad',
          }],
        })),
      ).toThrow(BootError);
    });

    it('throws when dispatch_commands entry is not an object', () => {
      expect(() =>
        validateBoundaryConfig(minimalValid({
          behaviors: [{
            name: 'b',
            match: { operationId: 'createThing', condition: 'true' },
            emit: 'Created',
            dispatch_commands: ['not-an-object'],
          }],
        })),
      ).toThrow(BootError);
    });

    it('throws when dispatch_commands entry missing boundary', () => {
      expect(() =>
        validateBoundaryConfig(minimalValid({
          behaviors: [{
            name: 'b',
            match: { operationId: 'createThing', condition: 'true' },
            emit: 'Created',
            dispatch_commands: [{ intent: 'mutation', target_id: 'x' }],
          }],
        })),
      ).toThrow(BootError);
    });

    it('throws when dispatch_commands entry has invalid intent', () => {
      expect(() =>
        validateBoundaryConfig(minimalValid({
          behaviors: [{
            name: 'b',
            match: { operationId: 'createThing', condition: 'true' },
            emit: 'Created',
            dispatch_commands: [{ boundary: 'B', intent: 'invalid', target_id: 'x' }],
          }],
        })),
      ).toThrow(BootError);
    });

    it('throws when dispatch_commands entry missing target_id', () => {
      expect(() =>
        validateBoundaryConfig(minimalValid({
          behaviors: [{
            name: 'b',
            match: { operationId: 'createThing', condition: 'true' },
            emit: 'Created',
            dispatch_commands: [{ boundary: 'B', intent: 'mutation' }],
          }],
        })),
      ).toThrow(BootError);
    });

    it('throws when dispatch payload value is not a string', () => {
      expect(() =>
        validateBoundaryConfig(minimalValid({
          behaviors: [{
            name: 'b',
            match: { operationId: 'createThing', condition: 'true' },
            emit: 'Created',
            dispatch_commands: [{
              boundary: 'B',
              intent: 'mutation',
              operationId: 'op',
              target_id: 'x',
              payload: { field: 123 },
            }],
          }],
        })),
      ).toThrow(BootError);
    });
  });

  // ── reducers ───────────────────────────────────────────────────────────────
  describe('reducers array', () => {
    it('throws when reducers is not an array', () => {
      expect(() =>
        validateBoundaryConfig(minimalValid({ reducers: 'bad' })),
      ).toThrow(BootError);
    });

    it('throws when reducer is not an object', () => {
      expect(() =>
        validateBoundaryConfig({
          boundary: 'B',
          contract_path: '/b',
          event_catalog: [{ type: 'Created', payload_template: {} }],
          behaviors: [],
          reducers: ['bad'],
        }),
      ).toThrow(BootError);
    });

    it('throws when reducer.on is missing', () => {
      expect(() =>
        validateBoundaryConfig({
          boundary: 'B',
          contract_path: '/b',
          event_catalog: [{ type: 'Created', payload_template: {} }],
          behaviors: [],
          reducers: [{ patches: [{ op: 'replace', path: '/field', value: '${"value"}' }] }],
        }),
      ).toThrow(BootError);
    });

    it('throws when reducer references unknown event type', () => {
      expect(() =>
        validateBoundaryConfig({
          boundary: 'B',
          contract_path: '/b',
          event_catalog: [{ type: 'Created', payload_template: {} }],
          behaviors: [],
          reducers: [{ on: 'NotInCatalog', patches: [] }],
        }),
      ).toThrow(BootError);
    });

    it('accepts reducer with a replace patch list', () => {
      const result = validateBoundaryConfig({
        boundary: 'B',
        contract_path: '/b',
        event_catalog: [{ type: 'Created', payload_template: {} }],
        behaviors: [],
        reducers: [{ on: 'Created', patches: [{ op: 'replace', path: '/status', value: '${event.payload.status}' }] }],
      });
      expect(result.reducers[0]?.patches?.[0]).toEqual({ op: 'replace', path: '/status', value: '${event.payload.status}' });
    });

    it('rejects reducer with removed assign key (BOOT_ERR_DSL_SYNTAX)', () => {
      let caught: BootError | undefined;
      try {
        validateBoundaryConfig({
          boundary: 'B',
          contract_path: '/b',
          event_catalog: [{ type: 'Created', payload_template: {} }],
          behaviors: [],
          reducers: [{ on: 'Created', assign: { status: 'event.payload.status' } }],
        });
      } catch (e) {
        caught = e as BootError;
      }
      expect(caught).toBeInstanceOf(BootError);
      expect(caught?.code).toBe('BOOT_ERR_DSL_SYNTAX');
    });

    it('throws when a patch op is invalid', () => {
      expect(() =>
        validateBoundaryConfig({
          boundary: 'B',
          contract_path: '/b',
          event_catalog: [{ type: 'Created', payload_template: {} }],
          behaviors: [],
          reducers: [{ on: 'Created', patches: [{ op: 'bogus', path: '/field' }] }],
        }),
      ).toThrow(BootError);
    });

    it('throws when patches is not an array', () => {
      expect(() =>
        validateBoundaryConfig({
          boundary: 'B',
          contract_path: '/b',
          event_catalog: [{ type: 'Created', payload_template: {} }],
          behaviors: [],
          reducers: [{ on: 'Created', patches: 'bad' }],
        }),
      ).toThrow(BootError);
    });

    it('accepts reducer with an append patch', () => {
      const result = validateBoundaryConfig({
        boundary: 'B',
        contract_path: '/b',
        event_catalog: [{ type: 'Created', payload_template: {} }],
        behaviors: [],
        reducers: [{ on: 'Created', patches: [{ op: 'append', path: '/items', value: '${event.payload.item}' }] }],
      });
      expect(result.reducers[0]?.patches?.[0]).toEqual({ op: 'append', path: '/items', value: '${event.payload.item}' });
    });

    it('rejects reducer with removed append key (BOOT_ERR_DSL_SYNTAX)', () => {
      let caught: BootError | undefined;
      try {
        validateBoundaryConfig({
          boundary: 'B',
          contract_path: '/b',
          event_catalog: [{ type: 'Created', payload_template: {} }],
          behaviors: [],
          reducers: [{ on: 'Created', append: { items: 'event.payload.item' } }],
        });
      } catch (e) {
        caught = e as BootError;
      }
      expect(caught).toBeInstanceOf(BootError);
      expect(caught?.code).toBe('BOOT_ERR_DSL_SYNTAX');
    });

    it('throws when a patch entry is not an object', () => {
      expect(() =>
        validateBoundaryConfig({
          boundary: 'B',
          contract_path: '/b',
          event_catalog: [{ type: 'Created', payload_template: {} }],
          behaviors: [],
          reducers: [{ on: 'Created', patches: ['bad'] }],
        }),
      ).toThrow(BootError);
    });

    it('throws when a patch path is missing', () => {
      expect(() =>
        validateBoundaryConfig({
          boundary: 'B',
          contract_path: '/b',
          event_catalog: [{ type: 'Created', payload_template: {} }],
          behaviors: [],
          reducers: [{ on: 'Created', patches: [{ op: 'replace', value: '${"x"}' }] }],
        }),
      ).toThrow(BootError);
    });
  });

  // ── event_catalog ──────────────────────────────────────────────────────────
  describe('event_catalog', () => {
    it('throws when event_catalog is not an array', () => {
      expect(() =>
        validateBoundaryConfig(minimalValid({ event_catalog: 'bad' })),
      ).toThrow(BootError);
    });

    it('throws when event_catalog entry is not an object', () => {
      expect(() =>
        validateBoundaryConfig({
          boundary: 'B',
          contract_path: '/b',
          event_catalog: ['bad'],
          behaviors: [],
          reducers: [],
        }),
      ).toThrow(BootError);
    });

    it('throws when event_catalog entry missing type', () => {
      expect(() =>
        validateBoundaryConfig({
          boundary: 'B',
          contract_path: '/b',
          event_catalog: [{ payload_template: {} }],
          behaviors: [],
          reducers: [],
        }),
      ).toThrow(BootError);
    });

    it('accepts event_catalog entry without payload_template (defaults to {})', () => {
      const result = validateBoundaryConfig({
        boundary: 'B',
        contract_path: '/b',
        event_catalog: [{ type: 'Created' }],
        behaviors: [],
        reducers: [],
      });
      expect(result.eventCatalog[0]?.payloadTemplate).toEqual({});
    });

    it('throws when payload_template value is not a string', () => {
      expect(() =>
        validateBoundaryConfig({
          boundary: 'B',
          contract_path: '/b',
          event_catalog: [{ type: 'Created', payload_template: { field: 123 } }],
          behaviors: [],
          reducers: [],
        }),
      ).toThrow(BootError);
    });

    it('throws when payload_template is not an object', () => {
      expect(() =>
        validateBoundaryConfig({
          boundary: 'B',
          contract_path: '/b',
          event_catalog: [{ type: 'Created', payload_template: 'bad' }],
          behaviors: [],
          reducers: [],
        }),
      ).toThrow(BootError);
    });
  });

  // ── cross-validation ────────────────────────────────────────────────────────
  describe('cross-reference validation', () => {
    it('throws BOOT_ERR_DSL_REFERENCE when behavior emits unknown event type', () => {
      try {
        validateBoundaryConfig({
          boundary: 'B',
          contract_path: '/b',
          event_catalog: [{ type: 'Created', payload_template: {} }],
          behaviors: [{ name: 'b', match: { operationId: 'createThing', condition: 'true' }, emit: 'NonExistent' }],
          reducers: [],
        });
        fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(BootError);
        expect((e as BootError).code).toBe('BOOT_ERR_DSL_REFERENCE');
      }
    });

    it('throws BOOT_ERR_DSL_REFERENCE when reducer references unknown event type', () => {
      try {
        validateBoundaryConfig({
          boundary: 'B',
          contract_path: '/b',
          event_catalog: [{ type: 'Created', payload_template: {} }],
          behaviors: [],
          reducers: [{ on: 'NonExistent' }],
        });
        fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(BootError);
        expect((e as BootError).code).toBe('BOOT_ERR_DSL_REFERENCE');
      }
    });
  });

  // ── initialization ─────────────────────────────────────────────────────────
  describe('initialization field', () => {
    it('parses valid initialization array of objects', () => {
      const result = validateBoundaryConfig(minimalValid({
        initialization: [{ status: 'seeded', count: 0 }],
      }));
      expect(result.initialization).toHaveLength(1);
    });

    it('throws when initialization is not an array', () => {
      expect(() =>
        validateBoundaryConfig(minimalValid({ initialization: 'bad' })),
      ).toThrow(BootError);
    });

    it('throws when initialization element is not an object', () => {
      expect(() =>
        validateBoundaryConfig(minimalValid({ initialization: ['bad'] })),
      ).toThrow(BootError);
    });

    it('empty initialization array is valid', () => {
      const result = validateBoundaryConfig(minimalValid({ initialization: [] }));
      expect(result.initialization).toHaveLength(0);
    });
  });

  // ── query_mapping ───────────────────────────────────────────────────────────
  describe('query_mapping field', () => {
    it('parses valid query_mapping', () => {
      const result = validateBoundaryConfig(minimalValid({
        query_mapping: { status: 'command.queryParams.status' },
      }));
      expect(result.queryMapping?.['status']).toBe('command.queryParams.status');
    });

    it('throws when query_mapping is not an object', () => {
      expect(() =>
        validateBoundaryConfig(minimalValid({ query_mapping: 'bad' })),
      ).toThrow(BootError);
    });

    it('throws when query_mapping value is not a string', () => {
      expect(() =>
        validateBoundaryConfig(minimalValid({ query_mapping: { field: 123 } })),
      ).toThrow(BootError);
    });
  });

  // ── full valid config ───────────────────────────────────────────────────────
  describe('full valid config parses correctly', () => {
    it('round-trips a complete config', () => {
      const raw = {
        boundary: 'Customer',
        contract_path: '/customers',
        fallback_override: false,
        identity: { creation: { generate: '$uuidv7()' } },
        query_mapping: { status: 'command.queryParams.status' },
        behaviors: [
          {
            name: 'register',
            match: { operationId: 'createThing', condition: 'true' },
            emit: 'Customer.Registered',
            dispatch_commands: [{
              boundary: 'AuditLog',
              intent: 'creation',
              operationId: 'op',
              target_id: '$uuidv7()',
              payload: { entityId: 'command.targetId' },
            }],
          },
        ],
        reducers: [
          {
            on: 'Customer.Registered',
            patches: [
              { op: 'replace', path: '/status', value: '${"active"}' },
              { op: 'replace', path: '/name', value: '${event.payload.name}' },
            ],
          },
        ],
        event_catalog: [
          { type: 'Customer.Registered', payload_template: { name: 'command.payload.name' } },
        ],
        initialization: [{ status: 'empty' }],
      };

      const result = validateBoundaryConfig(raw);
      expect(result.boundary).toBe('Customer');
      expect(result.behaviors).toHaveLength(1);
      expect(result.reducers).toHaveLength(1);
      expect(result.eventCatalog).toHaveLength(1);
      expect(result.behaviors[0]?.dispatchCommands).toHaveLength(1);
    });
  });
});
