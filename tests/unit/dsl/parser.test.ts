import { parseDslYaml, compileDsl } from '../../../src/dsl/parser';
import { BootError } from '../../../src/errors';

const minimalYaml = `
boundary: MyBoundary
contract_path: /my/path
behaviors: []
reducers: []
event_catalog: []
`;

describe('dsl/parser', () => {
  describe('parseDslYaml', () => {
    it('parses a minimal valid YAML module', () => {
      const config = parseDslYaml(minimalYaml);
      expect(config.boundary).toBe('MyBoundary');
      expect(config.contractPath).toBe('/my/path');
    });

    it('throws BootError with BOOT_ERR_DSL_SYNTAX on invalid YAML', () => {
      expect(() => parseDslYaml('{ invalid yaml {')).toThrow(BootError);
    });

    it('throws BootError with correct code on invalid YAML', () => {
      try {
        parseDslYaml('{ bad: [');
      } catch (e) {
        expect(e).toBeInstanceOf(BootError);
        expect((e as BootError).code).toBe('BOOT_ERR_DSL_SYNTAX');
      }
    });

    it('throws BootError on empty string', () => {
      expect(() => parseDslYaml('')).toThrow(BootError);
    });

    it('throws BootError on YAML array at root level', () => {
      expect(() => parseDslYaml('- item1\n- item2')).toThrow(BootError);
    });

    it('throws BootError on missing boundary field', () => {
      expect(() =>
        parseDslYaml('contract_path: /x\nbehaviors: []\nreducers: []\nevent_catalog: []'),
      ).toThrow(BootError);
    });

    it('parses behaviors from YAML', () => {
      const yaml = `
boundary: B
contract_path: /b
behaviors:
  - name: create
    match:
      operationId: createThing
      condition: "true"
    emit: Created
reducers:
  - on: Created
event_catalog:
  - type: Created
    payload_template: {}
`;
      const config = parseDslYaml(yaml);
      expect(config.behaviors).toHaveLength(1);
      expect(config.behaviors[0]?.name).toBe('create');
    });

    it('parses identity.creation.generate expression', () => {
      const yaml = `
boundary: B
contract_path: /b
identity:
  creation:
    generate: "$uuidv7()"
behaviors: []
reducers: []
event_catalog: []
`;
      const config = parseDslYaml(yaml);
      expect(config.identity?.creation?.generate).toBe('$uuidv7()');
    });

    it('parses fallback_override: true', () => {
      const yaml = `
boundary: B
contract_path: /b
fallback_override: true
behaviors: []
reducers: []
event_catalog: []
`;
      const config = parseDslYaml(yaml);
      expect(config.fallbackOverride).toBe(true);
    });

    it('parses a boundary latency block (fixed_ms / min_ms / max_ms)', () => {
      const yaml = `
boundary: B
contract_path: /b
latency:
  fixed_ms: 50
  min_ms: 10
  max_ms: 30
behaviors: []
reducers: []
event_catalog: []
`;
      const config = parseDslYaml(yaml);
      expect(config.latency).toEqual({ fixed_ms: 50, min_ms: 10, max_ms: 30 });
    });

    it('omits latency when the block is absent or carries no usable field', () => {
      const noBlock = parseDslYaml('boundary: B\ncontract_path: /b\nbehaviors: []\nreducers: []\nevent_catalog: []');
      expect(noBlock.latency).toBeUndefined();
      const negative = parseDslYaml('boundary: B\ncontract_path: /b\nlatency: { fixed_ms: -5 }\nbehaviors: []\nreducers: []\nevent_catalog: []');
      expect(negative.latency).toBeUndefined();
    });
  });

  describe('compileDsl', () => {
    it('compiles a single module', async () => {
      const result = await compileDsl([{ name: 'mod1', yaml: minimalYaml }]);
      expect(result.boundaries).toHaveLength(1);
      expect(result.byBoundaryName['MyBoundary']).toBeDefined();
    });

    it('indexes by contractPath', async () => {
      const result = await compileDsl([{ name: 'mod1', yaml: minimalYaml }]);
      expect(result.byContractPath['/my/path']).toBeDefined();
    });

    it('compiles multiple modules', async () => {
      const yaml2 = `
boundary: OtherBoundary
contract_path: /other
behaviors: []
reducers: []
event_catalog: []
`;
      const result = await compileDsl([
        { name: 'mod1', yaml: minimalYaml },
        { name: 'mod2', yaml: yaml2 },
      ]);
      expect(result.boundaries).toHaveLength(2);
    });

    it('throws BootError on duplicate boundary name', async () => {
      await expect(
        compileDsl([
          { name: 'mod1', yaml: minimalYaml },
          { name: 'mod2', yaml: minimalYaml },
        ]),
      ).rejects.toThrow(BootError);
    });

    it('throws BootError on duplicate contract_path', async () => {
      const yaml2 = `
boundary: OtherBoundary
contract_path: /my/path
behaviors: []
reducers: []
event_catalog: []
`;
      await expect(
        compileDsl([
          { name: 'mod1', yaml: minimalYaml },
          { name: 'mod2', yaml: yaml2 },
        ]),
      ).rejects.toThrow(BootError);
    });

    it('returns empty boundaries for empty module list', async () => {
      const result = await compileDsl([]);
      expect(result.boundaries).toHaveLength(0);
    });

    it('throws BootError with BOOT_ERR_DSL_DUPLICATE_BOUNDARY code', async () => {
      try {
        await compileDsl([
          { name: 'a', yaml: minimalYaml },
          { name: 'b', yaml: minimalYaml },
        ]);
      } catch (e) {
        expect(e).toBeInstanceOf(BootError);
        expect((e as BootError).code).toBe('BOOT_ERR_DSL_DUPLICATE_BOUNDARY');
      }
    });
  });
});
