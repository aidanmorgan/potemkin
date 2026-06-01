import { validatePotemkinConfig } from '../../../src/dsl/configSchema.js';
import { BootError } from '../../../src/errors.js';

// Tests for the optional-block validators added to validatePotemkinConfig
// (potemkin-sddz): typescript, plugin, seeds[], workflow, overlay, governance
// must all be structure-checked rather than passed through as raw casts.

const REQUIRED = {
  version: 1,
  specmatic: 'specmatic.yaml',
  modules: ['dsl/*.yaml'],
};

function catchBoot(fn: () => unknown): BootError {
  try {
    fn();
  } catch (e) {
    if (e instanceof BootError) return e;
    throw e;
  }
  throw new Error('expected a BootError to be thrown');
}

function valid(extra: Record<string, unknown>) {
  return validatePotemkinConfig({ ...REQUIRED, ...extra }, { source: 'potemkin.yaml' });
}

// ---------------------------------------------------------------------------
// Well-formed config passes
// ---------------------------------------------------------------------------

describe('validatePotemkinConfig — well-formed optional blocks pass', () => {
  it('accepts a config with no optional blocks', () => {
    const cfg = valid({});
    expect(cfg.version).toBe(1);
  });

  it('accepts a well-formed typescript block', () => {
    const cfg = valid({
      typescript: {
        scan: [{ include: ['src/**/*.ts'] }],
        watch: false,
      },
    });
    expect(cfg.typescript?.scan).toHaveLength(1);
  });

  it('accepts a well-formed plugin block', () => {
    const cfg = valid({
      plugin: { controlPort: 9000, engine: { url: 'http://localhost:3000' } },
    });
    expect(cfg.plugin?.controlPort).toBe(9000);
  });

  it('accepts a well-formed seeds array', () => {
    const cfg = valid({
      seeds: [
        {
          description: 'seed one',
          base: 'empty',
          request: { method: 'GET', path: '/leads/seed-1' },
          patches: [{ op: 'add', path: '/id', value: 'seed-1' }],
        },
        {
          base: 'contract',
          request: { method: 'POST', path: '/leads' },
        },
      ],
    });
    expect(cfg.seeds).toHaveLength(2);
  });

  it('accepts a well-formed workflow block', () => {
    const cfg = valid({
      workflow: {
        ids: {
          leadId: { extract: '$.body.id', use: '$.path.id' },
        },
      },
    });
    expect(cfg.workflow?.ids?.['leadId']).toEqual({ extract: '$.body.id', use: '$.path.id' });
  });

  it('accepts workflow with no ids', () => {
    const cfg = valid({ workflow: {} });
    expect(cfg.workflow).toBeDefined();
  });

  it('accepts a well-formed overlay block', () => {
    const cfg = valid({
      overlay: {
        patches: [{ op: 'replace', path: '/paths/~1leads/get/deprecated', value: true }],
      },
    });
    expect(cfg.overlay?.patches).toHaveLength(1);
  });

  it('accepts overlay with empty patches array', () => {
    const cfg = valid({ overlay: { patches: [] } });
    expect(cfg.overlay?.patches).toHaveLength(0);
  });

  it('accepts a well-formed governance block', () => {
    const cfg = valid({
      governance: {
        successCriterion: 'passingTests > 90',
        report: { format: 'html' },
      },
    });
    expect(cfg.governance?.successCriterion).toBe('passingTests > 90');
  });

  it('accepts governance with only successCriterion', () => {
    const cfg = valid({ governance: { successCriterion: 'ok' } });
    expect(cfg.governance?.successCriterion).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// typescript block — malformed
// ---------------------------------------------------------------------------

describe('validatePotemkinConfig — malformed typescript block', () => {
  it('rejects typescript: as a string', () => {
    const err = catchBoot(() => valid({ typescript: 'bad' }));
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/"typescript"/);
  });

  it('rejects typescript with no scan', () => {
    const err = catchBoot(() => valid({ typescript: {} }));
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/typescript\.scan/);
  });

  it('rejects typescript with empty scan array', () => {
    const err = catchBoot(() => valid({ typescript: { scan: [] } }));
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/typescript\.scan/);
  });

  it('rejects a scan entry with a missing include', () => {
    const err = catchBoot(() => valid({ typescript: { scan: [{}] } }));
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/typescript\.scan\[0\]/);
  });

  it('rejects a scan entry with an empty include array', () => {
    const err = catchBoot(() => valid({ typescript: { scan: [{ include: [] }] } }));
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/typescript\.scan\[0\]/);
  });

  it('rejects a scan entry with non-string include globs', () => {
    const err = catchBoot(() => valid({ typescript: { scan: [{ include: [123] }] } }));
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/typescript\.scan\[0\]/);
  });

  it('rejects typescript.watch as a non-boolean', () => {
    const err = catchBoot(() =>
      valid({ typescript: { scan: [{ include: ['src/**/*.ts'] }], watch: 'yes' } }),
    );
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/typescript\.watch/);
  });
});

// ---------------------------------------------------------------------------
// plugin block — malformed
// ---------------------------------------------------------------------------

describe('validatePotemkinConfig — malformed plugin block', () => {
  it('rejects plugin: as a string', () => {
    const err = catchBoot(() => valid({ plugin: 'bad' }));
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/"plugin"/);
  });

  it('rejects plugin.controlPort as a string', () => {
    const err = catchBoot(() => valid({ plugin: { controlPort: 'nine-thousand' } }));
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/plugin\.controlPort/);
  });

  it('rejects plugin.engine as a non-object', () => {
    const err = catchBoot(() => valid({ plugin: { engine: 'http://localhost:3000' } }));
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/plugin\.engine/);
  });
});

// ---------------------------------------------------------------------------
// seeds[] — malformed
// ---------------------------------------------------------------------------

describe('validatePotemkinConfig — malformed seeds block', () => {
  it('rejects seeds: as a non-array', () => {
    const err = catchBoot(() => valid({ seeds: 'bad' }));
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/"seeds"/);
  });

  it('rejects a seeds entry that is not an object', () => {
    const err = catchBoot(() => valid({ seeds: ['bad'] }));
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/seeds\[0\]/);
  });

  it('rejects a seed with a bad base value', () => {
    const err = catchBoot(() =>
      valid({
        seeds: [
          { base: 'wrong', request: { method: 'GET', path: '/leads' } },
        ],
      }),
    );
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/seeds\[0\]\.base/);
  });

  it('rejects a seed with request as a non-object (number)', () => {
    const err = catchBoot(() =>
      valid({ seeds: [{ base: 'empty', request: 123 }] }),
    );
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/seeds\[0\]\.request/);
  });

  it('rejects a seed with missing request.method', () => {
    const err = catchBoot(() =>
      valid({ seeds: [{ base: 'empty', request: { path: '/leads' } }] }),
    );
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/seeds\[0\]\.request\.method/);
  });

  it('rejects a seed with non-string request.method', () => {
    const err = catchBoot(() =>
      valid({ seeds: [{ base: 'empty', request: { method: 42, path: '/leads' } }] }),
    );
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/seeds\[0\]\.request\.method/);
  });

  it('rejects a seed with missing request.path', () => {
    const err = catchBoot(() =>
      valid({ seeds: [{ base: 'empty', request: { method: 'GET' } }] }),
    );
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/seeds\[0\]\.request\.path/);
  });

  it('rejects a seed with non-array patches', () => {
    const err = catchBoot(() =>
      valid({
        seeds: [
          { base: 'empty', request: { method: 'GET', path: '/leads' }, patches: 'bad' },
        ],
      }),
    );
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/seeds\[0\]\.patches/);
  });

  it('rejects a seed with non-string description', () => {
    const err = catchBoot(() =>
      valid({
        seeds: [
          { base: 'empty', request: { method: 'GET', path: '/leads' }, description: 999 },
        ],
      }),
    );
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/seeds\[0\]\.description/);
  });
});

// ---------------------------------------------------------------------------
// workflow block — malformed
// ---------------------------------------------------------------------------

describe('validatePotemkinConfig — malformed workflow block', () => {
  it('rejects workflow: as an array', () => {
    const err = catchBoot(() => valid({ workflow: [] }));
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/"workflow"/);
  });

  it('rejects workflow.ids as a non-object', () => {
    const err = catchBoot(() => valid({ workflow: { ids: 'bad' } }));
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/workflow\.ids/);
  });

  it('rejects a workflow.ids entry that is not an object', () => {
    const err = catchBoot(() => valid({ workflow: { ids: { leadId: 'bad' } } }));
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/workflow\.ids\.leadId/);
  });

  it('rejects a workflow.ids entry missing extract', () => {
    const err = catchBoot(() =>
      valid({ workflow: { ids: { leadId: { use: '$.path.id' } } } }),
    );
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/workflow\.ids\.leadId\.extract/);
  });

  it('rejects a workflow.ids entry missing use', () => {
    const err = catchBoot(() =>
      valid({ workflow: { ids: { leadId: { extract: '$.body.id' } } } }),
    );
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/workflow\.ids\.leadId\.use/);
  });
});

// ---------------------------------------------------------------------------
// overlay block — malformed
// ---------------------------------------------------------------------------

describe('validatePotemkinConfig — malformed overlay block', () => {
  it('rejects overlay: as a string', () => {
    const err = catchBoot(() => valid({ overlay: 'bad' }));
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/"overlay"/);
  });

  it('rejects overlay.patches as a non-array', () => {
    const err = catchBoot(() => valid({ overlay: { patches: 'bad' } }));
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/overlay\.patches/);
  });
});

// ---------------------------------------------------------------------------
// governance block — malformed
// ---------------------------------------------------------------------------

describe('validatePotemkinConfig — malformed governance block', () => {
  it('rejects governance: as an array', () => {
    const err = catchBoot(() => valid({ governance: ['bad'] }));
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/"governance"/);
  });

  it('rejects governance.report as a non-object', () => {
    const err = catchBoot(() => valid({ governance: { report: 'bad' } }));
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/governance\.report/);
  });

  it('rejects governance.successCriterion as a non-string', () => {
    const err = catchBoot(() => valid({ governance: { successCriterion: 42 } }));
    expect(err.code).toBe('BOOT_ERR_DSL_SCHEMA_VIOLATION');
    expect(err.message).toMatch(/governance\.successCriterion/);
  });
});
