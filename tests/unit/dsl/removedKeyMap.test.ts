import {
  REMOVED_KEY_MAP,
  validatePotemkinConfig,
  validateBoundaryModule,
} from '../../../src/dsl/configSchema';
import { BootError } from '../../../src/errors';

// Every legacy snake_case key in REMOVED_KEY_MAP is rejected with
// BOOT_ERR_REMOVED_SYNTAX, and the error names the camelCase replacement. The
// rejection runs in rejectSnakeCaseKeys, shared by both top-level validators
// (potemkin.yaml and boundary modules), so a key placed at the root of either
// document trips the same policy regardless of the other required fields.

const ENTRIES = Object.entries(REMOVED_KEY_MAP);

function catchBoot(fn: () => unknown): BootError {
  try {
    fn();
  } catch (e) {
    if (e instanceof BootError) return e;
    throw e;
  }
  throw new Error('expected a BootError to be thrown');
}

describe('REMOVED_KEY_MAP — legacy snake_case rejection', () => {
  it('contains exactly the 10 documented legacy keys', () => {
    expect(ENTRIES).toHaveLength(10);
    expect(Object.keys(REMOVED_KEY_MAP).sort()).toEqual(
      [
        'contract_path',
        'depends_on',
        'derived_projections',
        'dispatch_commands',
        'event_catalog',
        'out_of_contract',
        'payload_template',
        'seed_expectations',
        'spec_id',
        'state_schema',
      ].sort(),
    );
  });

  it.each(ENTRIES)(
    'potemkin.yaml validator rejects legacy "%s" and names replacement "%s"',
    (legacy, replacement) => {
      const raw = {
        version: 1,
        specmatic: 'specmatic.yaml',
        modules: ['dsl/*.yaml'],
        [legacy]: 'whatever',
      };
      const err = catchBoot(() => validatePotemkinConfig(raw, { source: 'potemkin.yaml' }));
      expect(err.code).toBe('BOOT_ERR_REMOVED_SYNTAX');
      expect(err.message).toContain(legacy);
      expect(err.message).toContain(replacement);
      expect(err.details).toMatchObject({ removed: legacy, replacement });
    },
  );

  it.each(ENTRIES)(
    'boundary-module validator rejects legacy "%s" and names replacement "%s"',
    (legacy, replacement) => {
      const raw = {
        boundary: 'B',
        specId: 'x',
        contractPath: '/b',
        events: [],
        [legacy]: 'whatever',
      };
      const err = catchBoot(() => validateBoundaryModule(raw, { source: 'dsl/b.yaml' }));
      expect(err.code).toBe('BOOT_ERR_REMOVED_SYNTAX');
      expect(err.message).toContain(legacy);
      expect(err.message).toContain(replacement);
      expect(err.details).toMatchObject({ removed: legacy, replacement });
    },
  );
});
