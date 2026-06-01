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
  reducers: [{ on: 'Created', patches: [{ op: 'replace', path: '/status', value: '${"active"}' }] }],
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

    it('parses a reducer patches list (replace + append) through to the config', () => {
      const raw = {
        boundary: 'B',
        contract_path: '/b',
        behaviors: [],
        reducers: [{
          on: 'Ev',
          patches: [
            { op: 'replace', path: '/field', value: '${"val"}' },
            { op: 'append', path: '/list', value: '${"item"}' },
          ],
        }],
        event_catalog: [{ type: 'Ev', payload_template: {} }],
      };
      const config = validateBoundaryConfig(raw);
      expect(config.reducers[0]?.patches).toEqual([
        { op: 'replace', path: '/field', value: '${"val"}' },
        { op: 'append', path: '/list', value: '${"item"}' },
      ]);
    });

    describe('patch operand finiteness guards', () => {
      function makeIncrementConfig(by: unknown) {
        return {
          boundary: 'B',
          contract_path: '/b',
          behaviors: [],
          reducers: [{ on: 'Ev', patches: [{ op: 'increment', path: '/count', by }] }],
          event_catalog: [{ type: 'Ev', payload_template: {} }],
        };
      }

      it('accepts a finite increment by value', () => {
        expect(() => validateBoundaryConfig(makeIncrementConfig(1))).not.toThrow();
      });

      it('rejects increment by: Infinity with BOOT_ERR_DSL_SYNTAX', () => {
        let caught: unknown;
        try {
          validateBoundaryConfig(makeIncrementConfig(Infinity));
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(BootError);
        expect((caught as BootError).code).toBe('BOOT_ERR_DSL_SYNTAX');
        expect((caught as BootError).message).toMatch(/by.*finite/i);
      });

      it('rejects increment by: NaN with BOOT_ERR_DSL_SYNTAX', () => {
        let caught: unknown;
        try {
          validateBoundaryConfig(makeIncrementConfig(NaN));
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(BootError);
        expect((caught as BootError).code).toBe('BOOT_ERR_DSL_SYNTAX');
        expect((caught as BootError).message).toMatch(/by.*finite/i);
      });

      it('rejects add value: Infinity with BOOT_ERR_DSL_SYNTAX', () => {
        const raw = {
          boundary: 'B',
          contract_path: '/b',
          behaviors: [],
          reducers: [{ on: 'Ev', patches: [{ op: 'add', path: '/score', value: Infinity }] }],
          event_catalog: [{ type: 'Ev', payload_template: {} }],
        };
        let caught: unknown;
        try {
          validateBoundaryConfig(raw);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(BootError);
        expect((caught as BootError).code).toBe('BOOT_ERR_DSL_SYNTAX');
        expect((caught as BootError).message).toMatch(/value.*finite/i);
      });
    });

    it('rejects removed reducer key assign with BOOT_ERR_REMOVED_SYNTAX', () => {
      const raw = {
        boundary: 'B',
        contract_path: '/b',
        behaviors: [],
        reducers: [{ on: 'Ev', assign: { field: '"val"' } }],
        event_catalog: [{ type: 'Ev', payload_template: {} }],
      };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
      try {
        validateBoundaryConfig(raw);
      } catch (e) {
        expect((e as BootError).code).toBe('BOOT_ERR_REMOVED_SYNTAX');
      }
    });

    it('rejects removed reducer key append with BOOT_ERR_REMOVED_SYNTAX', () => {
      const raw = {
        boundary: 'B',
        contract_path: '/b',
        behaviors: [],
        reducers: [{ on: 'Ev', append: { list: '"item"' } }],
        event_catalog: [{ type: 'Ev', payload_template: {} }],
      };
      expect(() => validateBoundaryConfig(raw)).toThrow(BootError);
      try {
        validateBoundaryConfig(raw);
      } catch (e) {
        expect((e as BootError).code).toBe('BOOT_ERR_REMOVED_SYNTAX');
      }
    });

    it('throws BootError for BOOT_ERR_DSL_SYNTAX code on invalid input', () => {
      try {
        validateBoundaryConfig(null);
      } catch (e) {
        expect(e).toBeInstanceOf(BootError);
        expect((e as BootError).code).toBe('BOOT_ERR_DSL_SYNTAX');
      }
    });

    describe('audit_fields', () => {
      it('maps audit_fields: true to boundary.auditFields', () => {
        const config = validateBoundaryConfig({ ...minimalValid, audit_fields: true });
        expect(config.auditFields).toBe(true);
      });

      it('maps audit_fields: false to boundary.auditFields', () => {
        const config = validateBoundaryConfig({ ...minimalValid, audit_fields: false });
        expect(config.auditFields).toBe(false);
      });

      it('leaves auditFields undefined when audit_fields is absent', () => {
        const config = validateBoundaryConfig(minimalValid);
        expect(config.auditFields).toBeUndefined();
      });

      it('throws BootError when audit_fields is not a boolean', () => {
        expect(() => validateBoundaryConfig({ ...minimalValid, audit_fields: 'yes' })).toThrow(BootError);
      });
    });

    describe('boundary-level fault_rules', () => {
      it('maps fault_rules to boundary.faults', () => {
        const config = validateBoundaryConfig({
          ...minimalValid,
          fault_rules: [
            {
              name: 'duplicate-check-slow',
              match: { intent: 'creation', condition: 'command.payload.checkDuplicates == true' },
              response: { status: 504, body: { error: 'TIMEOUT' }, delay_ms: 50 },
            },
          ],
        });
        expect(config.faults).toHaveLength(1);
        expect(config.faults?.[0]?.name).toBe('duplicate-check-slow');
        expect(config.faults?.[0]?.match.intent).toBe('creation');
        expect(config.faults?.[0]?.response.status).toBe(504);
      });

      it('leaves faults undefined when fault_rules is absent', () => {
        const config = validateBoundaryConfig(minimalValid);
        expect(config.faults).toBeUndefined();
      });

      it('throws BootError when fault_rules is not an array', () => {
        expect(() => validateBoundaryConfig({ ...minimalValid, fault_rules: {} })).toThrow(BootError);
      });
    });

    describe('behavior match.method and HATEOAS link fields', () => {
      const withBehavior = (behavior: Record<string, unknown>) => ({
        ...minimalValid,
        behaviors: [behavior],
      });

      it('maps match.method to behavior.match.method, uppercased', () => {
        const config = validateBoundaryConfig(withBehavior({
          name: 'convertLead',
          match: { operationId: 'convertLead', condition: 'true', method: 'post' },
          emit: 'Created',
        }));
        expect(config.behaviors[0]?.match.method).toBe('POST');
      });

      it('throws BootError when match.method is an empty string', () => {
        expect(() => validateBoundaryConfig(withBehavior({
          name: 'convertLead',
          match: { operationId: 'convertLead', condition: 'true', method: '' },
          emit: 'Created',
        }))).toThrow(BootError);
      });

      it('maps link_name to behavior.linkName', () => {
        const config = validateBoundaryConfig(withBehavior({
          name: 'convertLead',
          link_name: 'convert',
          match: { operationId: 'convertLead', condition: 'true' },
          emit: 'Created',
        }));
        expect(config.behaviors[0]?.linkName).toBe('convert');
      });

      it('maps link_condition to behavior.linkCondition', () => {
        const config = validateBoundaryConfig(withBehavior({
          name: 'convertLead',
          link_name: 'convert',
          link_condition: "state.status == 'QUALIFIED'",
          match: { operationId: 'convertLead', condition: 'true' },
          emit: 'Created',
        }));
        expect(config.behaviors[0]?.linkCondition).toBe("state.status == 'QUALIFIED'");
      });

      it('throws BootError when link_condition is not valid CEL', () => {
        expect(() => validateBoundaryConfig(withBehavior({
          name: 'convertLead',
          link_condition: 'state.status ==',
          match: { operationId: 'convertLead', condition: 'true' },
          emit: 'Created',
        }))).toThrow(BootError);
      });

      it('leaves method/linkName/linkCondition undefined when absent', () => {
        const config = validateBoundaryConfig(minimalValid);
        expect(config.behaviors[0]?.match.method).toBeUndefined();
        expect(config.behaviors[0]?.linkName).toBeUndefined();
        expect(config.behaviors[0]?.linkCondition).toBeUndefined();
      });
    });
  });
});
