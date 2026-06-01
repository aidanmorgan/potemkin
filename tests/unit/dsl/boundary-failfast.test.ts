import { validateBoundaryConfig } from '../../../src/dsl/schema';
import { BootError } from '../../../src/errors';

// validateBoundaryConfig must fail-fast on unknown top-level keys
// (symmetric with validateGlobalConfig), so a boundary-DSL typo is rejected at
// boot instead of being silently dropped.

const VALID = {
  boundary: 'Widget',
  contract_path: '/widgets',
  behaviors: [],
  reducers: [],
  event_catalog: [],
};

describe('validateBoundaryConfig unknown-key fail-fast', () => {
  it('parses a valid boundary with only known keys', () => {
    const cfg = validateBoundaryConfig(VALID);
    expect(cfg.boundary).toBe('Widget');
    expect(cfg.contractPath).toBe('/widgets');
  });

  it('rejects a misspelled key (reducerss) with BOOT_ERR_DSL_SYNTAX', () => {
    let err: BootError | null = null;
    try {
      validateBoundaryConfig({ ...VALID, reducerss: [] });
    } catch (e) {
      err = e instanceof BootError ? e : null;
    }
    expect(err?.code).toBe('BOOT_ERR_DSL_SYNTAX');
    expect(err?.message).toMatch(/Unknown boundary key "reducerss"/);
    expect(err?.message).toMatch(/supported keys:/);
  });

  it('rejects a typo of an optional key (audit_field vs audit_fields)', () => {
    let err: BootError | null = null;
    try {
      validateBoundaryConfig({ ...VALID, audit_field: true });
    } catch (e) {
      err = e instanceof BootError ? e : null;
    }
    expect(err?.code).toBe('BOOT_ERR_DSL_SYNTAX');
    expect(err?.message).toMatch(/Unknown boundary key "audit_field"/);
  });
});
