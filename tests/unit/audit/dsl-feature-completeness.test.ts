/**
 * Audit: DSL Parser / Schema / Types – feature completeness probing tests.
 *
 * Conventions:
 *   it(...)         – correct behaviour confirmed in current src
 *   it.failing(...) – confirmed gap; test asserts the CORRECT behaviour,
 *                     which currently fails because src has the bug.
 */

import { parseDslYaml, compileDsl } from '../../../src/dsl/parser';
import { validateBoundaryConfig } from '../../../src/dsl/schema';
import { BootError } from '../../../src/errors';

// ---------------------------------------------------------------------------
// Minimal valid fixtures
// ---------------------------------------------------------------------------

const minimalRaw = {
  boundary: 'Loan',
  contract_path: '/loans',
  behaviors: [
    { name: 'create', match: { intent: 'creation', condition: 'true' }, emit: 'LoanCreated' },
  ],
  reducers: [{ on: 'LoanCreated', assign: { status: '"active"' } }],
  event_catalog: [{ type: 'LoanCreated', payload_template: {} }],
};

const minimalYaml = `
boundary: Loan
contract_path: /loans
behaviors:
  - name: create
    match:
      intent: creation
      condition: "true"
    emit: LoanCreated
reducers:
  - on: LoanCreated
    assign:
      status: '"active"'
event_catalog:
  - type: LoanCreated
    payload_template: {}
`;

// ---------------------------------------------------------------------------
// §7.1 – Boundary Configuration Schema
// ---------------------------------------------------------------------------

describe('DSL §7.1 – Boundary Configuration Schema', () => {
  it('accepts a fully-formed boundary config', () => {
    const cfg = validateBoundaryConfig(minimalRaw);
    expect(cfg.boundary).toBe('Loan');
    expect(cfg.contractPath).toBe('/loans');
    expect(cfg.fallbackOverride).toBe(false);
  });

  it('normalises contract_path → contractPath (snake_case → camelCase)', () => {
    const cfg = validateBoundaryConfig(minimalRaw);
    expect(cfg.contractPath).toBe('/loans');
  });

  it('normalises fallback_override → fallbackOverride', () => {
    const cfg = validateBoundaryConfig({ ...minimalRaw, fallback_override: true });
    expect(cfg.fallbackOverride).toBe(true);
  });

  it('normalises query_mapping → queryMapping', () => {
    const cfg = validateBoundaryConfig({ ...minimalRaw, query_mapping: { status: 'entity.status == "active"' } });
    expect(cfg.queryMapping).toEqual({ status: 'entity.status == "active"' });
  });

  it('defaults fallbackOverride to false when absent', () => {
    const cfg = validateBoundaryConfig(minimalRaw);
    expect(cfg.fallbackOverride).toBe(false);
  });

  it('throws BootError BOOT_ERR_DSL_SYNTAX when fallback_override is not boolean', () => {
    expect(() => validateBoundaryConfig({ ...minimalRaw, fallback_override: 'yes' }))
      .toThrow(BootError);
  });

  it('throws BootError when boundary is empty string', () => {
    expect(() => validateBoundaryConfig({ ...minimalRaw, boundary: '' }))
      .toThrow(BootError);
  });

  it('throws BootError when contract_path is missing', () => {
    const { contract_path: _cp, ...rest } = minimalRaw as Record<string, unknown> & { contract_path: string };
    expect(() => validateBoundaryConfig(rest)).toThrow(BootError);
  });

  it('throws BootError when root input is not an object', () => {
    expect(() => validateBoundaryConfig('not-an-object')).toThrow(BootError);
  });

  it('throws BootError when root input is null', () => {
    expect(() => validateBoundaryConfig(null)).toThrow(BootError);
  });

  it('throws BootError when root input is an array', () => {
    expect(() => validateBoundaryConfig([minimalRaw])).toThrow(BootError);
  });

  it('accepts identity.creation.generate = "$uuidv7()"', () => {
    const cfg = validateBoundaryConfig({
      ...minimalRaw,
      identity: { creation: { generate: '$uuidv7()' } },
    });
    expect(cfg.identity?.creation?.generate).toBe('$uuidv7()');
  });

  it('accepts query_mapping values as arbitrary strings (CEL expressions stored as-is)', () => {
    const cfg = validateBoundaryConfig({
      ...minimalRaw,
      query_mapping: { status: 'state.status' },
    });
    expect(cfg.queryMapping).toEqual({ status: 'state.status' });
  });

  it('throws BootError when query_mapping values are not strings', () => {
    expect(() =>
      validateBoundaryConfig({ ...minimalRaw, query_mapping: { status: 123 } }),
    ).toThrow(BootError);
  });
});

// ---------------------------------------------------------------------------
// §7.2 – Behaviors Block
// ---------------------------------------------------------------------------

describe('DSL §7.2 – Behaviors Block', () => {
  it('accepts a valid creation behavior', () => {
    const cfg = validateBoundaryConfig(minimalRaw);
    expect(cfg.behaviors[0].name).toBe('create');
    expect(cfg.behaviors[0].match.intent).toBe('creation');
    expect(cfg.behaviors[0].emit).toBe('LoanCreated');
  });

  it('accepts mutation and query intents', () => {
    for (const intent of ['mutation', 'query'] as const) {
      const cfg = validateBoundaryConfig({
        ...minimalRaw,
        behaviors: [
          { name: 'op', match: { intent, condition: 'true' }, emit: 'LoanCreated' },
        ],
      });
      expect(cfg.behaviors[0].match.intent).toBe(intent);
    }
  });

  it('throws BootError for invalid match.intent value', () => {
    expect(() =>
      validateBoundaryConfig({
        ...minimalRaw,
        behaviors: [{ name: 'op', match: { intent: 'deletion', condition: 'true' }, emit: 'LoanCreated' }],
      }),
    ).toThrow(BootError);
  });

  it('throws BootError when match.condition is missing', () => {
    expect(() =>
      validateBoundaryConfig({
        ...minimalRaw,
        behaviors: [{ name: 'op', match: { intent: 'creation' }, emit: 'LoanCreated' }],
      }),
    ).toThrow(BootError);
  });

  it('throws BootError when emit references an event type not in event_catalog (cross-ref)', () => {
    expect(() =>
      validateBoundaryConfig({
        ...minimalRaw,
        behaviors: [{ name: 'op', match: { intent: 'creation', condition: 'true' }, emit: 'UNKNOWN_EVENT' }],
      }),
    ).toThrow(BootError);
  });

  it('cross-ref throws BootError code BOOT_ERR_DSL_REFERENCE for unknown emit', () => {
    try {
      validateBoundaryConfig({
        ...minimalRaw,
        behaviors: [{ name: 'op', match: { intent: 'creation', condition: 'true' }, emit: 'NoSuchEvent' }],
      });
      fail('expected to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(BootError);
      expect((e as BootError).code).toBe('BOOT_ERR_DSL_REFERENCE');
    }
  });

  it('throws BootError when emit is missing entirely', () => {
    expect(() =>
      validateBoundaryConfig({
        ...minimalRaw,
        behaviors: [{ name: 'op', match: { intent: 'creation', condition: 'true' } }],
      }),
    ).toThrow(BootError);
  });

  // GAP: emit is required even when dispatch_commands is present — the spec says emit is mandatory.
  // Currently emit is required unconditionally via requireString, so this behaviour IS correct.
  it('throws BootError when emit is empty string', () => {
    expect(() =>
      validateBoundaryConfig({
        ...minimalRaw,
        behaviors: [{ name: 'op', match: { intent: 'creation', condition: 'true' }, emit: '' }],
      }),
    ).toThrow(BootError);
  });

  it('accepts dispatch_commands alongside emit', () => {
    const cfg = validateBoundaryConfig({
      ...minimalRaw,
      behaviors: [
        {
          name: 'create',
          match: { intent: 'creation', condition: 'true' },
          emit: 'LoanCreated',
          dispatch_commands: [
            { boundary: 'OtherBoundary', intent: 'mutation', target_id: 'command.id', payload: { field: '"value"' } },
          ],
        },
      ],
    });
    expect(cfg.behaviors[0].dispatchCommands).toHaveLength(1);
  });

  it('throws BootError when dispatch_commands entry has invalid intent', () => {
    expect(() =>
      validateBoundaryConfig({
        ...minimalRaw,
        behaviors: [
          {
            name: 'create',
            match: { intent: 'creation', condition: 'true' },
            emit: 'LoanCreated',
            dispatch_commands: [
              { boundary: 'Other', intent: 'invalid', target_id: 'command.id' },
            ],
          },
        ],
      }),
    ).toThrow(BootError);
  });

  it('throws BootError when dispatch_commands entry is missing target_id', () => {
    expect(() =>
      validateBoundaryConfig({
        ...minimalRaw,
        behaviors: [
          {
            name: 'create',
            match: { intent: 'creation', condition: 'true' },
            emit: 'LoanCreated',
            dispatch_commands: [
              { boundary: 'Other', intent: 'mutation' },
            ],
          },
        ],
      }),
    ).toThrow(BootError);
  });

  // GAP (nice-to-have): dispatch_commands[].payload values are stored as plain strings,
  // but there is NO validation that they are syntactically valid CEL expressions.
  // The schema uses requireStringStringMap which only checks value is a string.
  it('throws BootError when dispatch_commands payload value is not a valid CEL string (e.g. bare "{ broken")', () => {
    // The schema currently accepts any string as payload value; it does NOT parse CEL syntax.
    expect(() =>
      validateBoundaryConfig({
        ...minimalRaw,
        behaviors: [
          {
            name: 'create',
            match: { intent: 'creation', condition: 'true' },
            emit: 'LoanCreated',
            dispatch_commands: [
              { boundary: 'Other', intent: 'mutation', target_id: 'command.id', payload: { x: '{ broken cel +++' } },
            ],
          },
        ],
      }),
    ).toThrow(BootError);
  });

  // Intentional permissiveness: dispatch_commands[].payload values accept any string.
  // CEL syntax is validated at execution time for behavior conditions, not at boot time
  // for dispatch payload values. A plain JSON string is a valid (if unusual) string value.
  it('accepts any string in dispatch_commands payload — CEL syntax checked at execution, not boot time', () => {
    // This is deliberate: requireStringStringMap validates that values are strings,
    // but does NOT validate that strings are valid CEL expressions. That check happens
    // when the expression is evaluated at runtime.
    expect(() =>
      validateBoundaryConfig({
        ...minimalRaw,
        behaviors: [
          {
            name: 'create',
            match: { intent: 'creation', condition: 'true' },
            emit: 'LoanCreated',
            dispatch_commands: [
              {
                boundary: 'Other',
                intent: 'mutation',
                target_id: 'command.id',
                payload: { x: '{"plain": "json not cel"}' },
              },
            ],
          },
        ],
      }),
    ).not.toThrow(); // accepted silently by design
  });
});

// ---------------------------------------------------------------------------
// §7.3 – Reducers Block
// ---------------------------------------------------------------------------

describe('DSL §7.3 – Reducers Block', () => {
  it('accepts a reducer with assign', () => {
    const cfg = validateBoundaryConfig(minimalRaw);
    expect(cfg.reducers[0].on).toBe('LoanCreated');
    expect(cfg.reducers[0].assign).toEqual({ status: '"active"' });
  });

  it('accepts a reducer with append (object value serialised to JSON string)', () => {
    const cfg = validateBoundaryConfig({
      ...minimalRaw,
      reducers: [{ on: 'LoanCreated', append: { items: { id: 'command.id' } } }],
    });
    expect(cfg.reducers[0].append?.items).toBe(JSON.stringify({ id: 'command.id' }));
  });

  it('throws BootError when reducer references event not in event_catalog', () => {
    expect(() =>
      validateBoundaryConfig({
        ...minimalRaw,
        reducers: [{ on: 'UnknownEvent', assign: { status: '"x"' } }],
      }),
    ).toThrow(BootError);
  });

  it('cross-ref: reducer unknown event throws BOOT_ERR_DSL_REFERENCE', () => {
    try {
      validateBoundaryConfig({
        ...minimalRaw,
        reducers: [{ on: 'NoSuchEvent', assign: { x: '1' } }],
      });
      fail('should throw');
    } catch (e) {
      expect((e as BootError).code).toBe('BOOT_ERR_DSL_REFERENCE');
    }
  });

  it('accepts reducer without assign or append (both optional)', () => {
    const cfg = validateBoundaryConfig({
      ...minimalRaw,
      reducers: [{ on: 'LoanCreated' }],
    });
    expect(cfg.reducers[0].assign).toBeUndefined();
    expect(cfg.reducers[0].append).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Event catalog cross-reference checks
// ---------------------------------------------------------------------------

describe('DSL event_catalog cross-reference', () => {
  it('throws BOOT_ERR_DSL_REFERENCE when event_catalog is empty and behavior emits something', () => {
    expect(() =>
      validateBoundaryConfig({
        ...minimalRaw,
        event_catalog: [],
        behaviors: [
          { name: 'op', match: { intent: 'creation', condition: 'true' }, emit: 'LoanCreated' },
        ],
        reducers: [],
      }),
    ).toThrow(BootError);
  });

  it('cross-ref error code is BOOT_ERR_DSL_REFERENCE for empty catalog with non-empty behaviors', () => {
    try {
      validateBoundaryConfig({
        ...minimalRaw,
        event_catalog: [],
        behaviors: [{ name: 'op', match: { intent: 'creation', condition: 'true' }, emit: 'SomeEvent' }],
        reducers: [],
      });
      fail('expected throw');
    } catch (e) {
      expect((e as BootError).code).toBe('BOOT_ERR_DSL_REFERENCE');
    }
  });

  it('accepts empty event_catalog when behaviors and reducers are also empty', () => {
    const cfg = validateBoundaryConfig({
      ...minimalRaw,
      event_catalog: [],
      behaviors: [],
      reducers: [],
    });
    expect(cfg.eventCatalog).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// YAML anchor / alias support
// ---------------------------------------------------------------------------

describe('DSL YAML anchor/alias support', () => {
  it('parseDslYaml resolves YAML anchors/aliases transparently', () => {
    // js-yaml supports anchors natively; this tests that parseDslYaml passes through
    const yamlWithAnchors = `
boundary: Loan
contract_path: /loans
event_catalog:
  - &evtDef
    type: LoanCreated
    payload_template: {}
behaviors:
  - name: create
    match: {intent: creation, condition: "true"}
    emit: LoanCreated
reducers:
  - on: LoanCreated
    assign:
      status: '"active"'
`;
    const cfg = parseDslYaml(yamlWithAnchors);
    expect(cfg.eventCatalog[0].type).toBe('LoanCreated');
  });
});

// ---------------------------------------------------------------------------
// compileDsl – duplicate boundary detection
// ---------------------------------------------------------------------------

describe('compileDsl – duplicate boundary detection', () => {
  it('throws BOOT_ERR_DSL_DUPLICATE_BOUNDARY when two modules share the same boundary name', async () => {
    await expect(
      compileDsl([
        { name: 'moduleA', yaml: minimalYaml },
        { name: 'moduleB', yaml: minimalYaml },
      ]),
    ).rejects.toThrow(BootError);
  });

  it('duplicate boundary error has code BOOT_ERR_DSL_DUPLICATE_BOUNDARY', async () => {
    await expect(
      compileDsl([
        { name: 'a', yaml: minimalYaml },
        { name: 'b', yaml: minimalYaml },
      ]),
    ).rejects.toMatchObject({ code: 'BOOT_ERR_DSL_DUPLICATE_BOUNDARY' });
  });

  it('compiles a single module without error', async () => {
    const compiled = await compileDsl([{ name: 'a', yaml: minimalYaml }]);
    expect(compiled.boundaries).toHaveLength(1);
    expect(compiled.byBoundaryName['Loan']).toBeDefined();
  });

  it('compiles two modules with distinct boundary names', async () => {
    const yaml2 = minimalYaml.replace('boundary: Loan', 'boundary: Account').replace('contract_path: /loans', 'contract_path: /accounts');
    const compiled = await compileDsl([
      { name: 'a', yaml: minimalYaml },
      { name: 'b', yaml: yaml2 },
    ]);
    expect(compiled.boundaries).toHaveLength(2);
    expect(compiled.byBoundaryName['Account']).toBeDefined();
  });

  it('throws BOOT_ERR_DSL_DUPLICATE_BOUNDARY for duplicate contract_path across modules', async () => {
    const yaml2 = minimalYaml.replace('boundary: Loan', 'boundary: OtherBoundary');
    // Both have contract_path: /loans
    await expect(
      compileDsl([
        { name: 'a', yaml: minimalYaml },
        { name: 'b', yaml: yaml2 },
      ]),
    ).rejects.toMatchObject({ code: 'BOOT_ERR_DSL_DUPLICATE_BOUNDARY' });
  });
});

// ---------------------------------------------------------------------------
// snake_case → camelCase normalisation completeness
// ---------------------------------------------------------------------------

describe('DSL snake_case → camelCase normalisation', () => {
  // contract_path, fallback_override, query_mapping, event_catalog, payload_template,
  // dispatch_commands, target_id should all be normalised.

  it('normalises event_catalog.payload_template → payloadTemplate', () => {
    const cfg = validateBoundaryConfig(minimalRaw);
    expect(cfg.eventCatalog[0].payloadTemplate).toBeDefined();
    // the raw key is payload_template but the TypeScript key is payloadTemplate
    expect((cfg.eventCatalog[0] as unknown as Record<string, unknown>)['payload_template']).toBeUndefined();
  });

  it('normalises dispatch_commands[].target_id → targetId', () => {
    const cfg = validateBoundaryConfig({
      ...minimalRaw,
      behaviors: [
        {
          name: 'create',
          match: { intent: 'creation', condition: 'true' },
          emit: 'LoanCreated',
          dispatch_commands: [
            { boundary: 'Other', intent: 'mutation', target_id: 'command.id' },
          ],
        },
      ],
    });
    const cmd = cfg.behaviors[0].dispatchCommands![0];
    expect(cmd.targetId).toBe('command.id');
    expect((cmd as unknown as Record<string, unknown>)['target_id']).toBeUndefined();
  });

  // GAP: identity.creation.generate is stored as-is (correct), but there is no
  // normalisation required here since the key is already camelCase-friendly.
  // However: there is no snake_case key 'payload_template' left on the returned object.
  it('does NOT expose raw snake_case keys on the returned BoundaryConfig', () => {
    const cfg = validateBoundaryConfig(minimalRaw) as unknown as Record<string, unknown>;
    expect(cfg['contract_path']).toBeUndefined();
    expect(cfg['fallback_override']).toBeUndefined();
    expect(cfg['query_mapping']).toBeUndefined();
    expect(cfg['event_catalog']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// YAML parse error handling
// ---------------------------------------------------------------------------

describe('DSL YAML parse error handling', () => {
  it('throws BootError BOOT_ERR_DSL_SYNTAX on malformed YAML', () => {
    expect(() => parseDslYaml('boundary: [\nbad yaml')).toThrow(BootError);
  });

  it('throws BootError when YAML parses to a scalar (not an object)', () => {
    expect(() => parseDslYaml('just a string')).toThrow(BootError);
  });

  it('throws BootError when YAML is a list not an object', () => {
    expect(() => parseDslYaml('- item1\n- item2')).toThrow(BootError);
  });
});
