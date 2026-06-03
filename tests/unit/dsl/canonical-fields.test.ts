/**
 * DSL canonical vs legacy field-name acceptance tests.
 *
 * Verifies that:
 *  1. scripts: is removed — any boundary YAML containing scripts: halts boot with
 *     BOOT_ERR_REMOVED_SYNTAX (both code: and source: forms were removed together).
 *  2. requires[].condition (canonical) and requires[].expression (legacy) parse identically.
 *  3. postcondition: "<string>" (canonical) and postcondition: {expression: "..."} (legacy)
 *     parse identically.
 *
 * Both forms must produce the same TypeScript object — no information lost or gained.
 */

import { validateBoundaryConfig } from '../../../src/dsl/schema';
import { BootError } from '../../../src/errors';

// ---------------------------------------------------------------------------
// Minimal valid boundary config factory
// ---------------------------------------------------------------------------

function makeBase() {
  return {
    boundary: 'Test',
    contract_path: '/test',
    event_catalog: [{ type: 'Evt', payload_template: {} }],
    reducers: [{ on: 'Evt', patches: [{ op: 'replace', path: '/x', value: '${"y"}' }] }],
  };
}

// ---------------------------------------------------------------------------
// 1. scripts: key is removed — all forms throw BOOT_ERR_REMOVED_SYNTAX
// ---------------------------------------------------------------------------

describe('DSL removed syntax: scripts: key (B3)', () => {
  const scriptBody = 'export default function(ctx) { return ctx.state.x; }';

  it('throws BOOT_ERR_REMOVED_SYNTAX when scripts: block is present with code:', () => {
    let caught: BootError | undefined;
    try {
      validateBoundaryConfig({
        ...makeBase(),
        behaviors: [{ name: 'b', match: { operationId: 'updateThing', condition: 'true' }, emit: 'Evt' }],
        scripts: [{ name: 'myScript', code: scriptBody }],
      } as unknown as Record<string, unknown>);
    } catch (e) {
      caught = e as BootError;
    }
    expect(caught).toBeInstanceOf(BootError);
    expect(caught!.code).toBe('BOOT_ERR_REMOVED_SYNTAX');
    expect(caught!.message).toContain('@Script');
  });

  it('throws BOOT_ERR_REMOVED_SYNTAX when scripts: block is present with source:', () => {
    let caught: BootError | undefined;
    try {
      validateBoundaryConfig({
        ...makeBase(),
        behaviors: [{ name: 'b', match: { operationId: 'updateThing', condition: 'true' }, emit: 'Evt' }],
        scripts: [{ name: 'myScript', source: scriptBody }],
      } as unknown as Record<string, unknown>);
    } catch (e) {
      caught = e as BootError;
    }
    expect(caught).toBeInstanceOf(BootError);
    expect(caught!.code).toBe('BOOT_ERR_REMOVED_SYNTAX');
    expect(caught!.message).toContain('ts:<id>');
  });

  it('throws BOOT_ERR_REMOVED_SYNTAX when scripts: block is present with no code field', () => {
    let caught: BootError | undefined;
    try {
      validateBoundaryConfig({
        ...makeBase(),
        behaviors: [{ name: 'b', match: { operationId: 'updateThing', condition: 'true' }, emit: 'Evt' }],
        scripts: [{ name: 'myScript' }],
      } as unknown as Record<string, unknown>);
    } catch (e) {
      caught = e as BootError;
    }
    expect(caught).toBeInstanceOf(BootError);
    expect(caught!.code).toBe('BOOT_ERR_REMOVED_SYNTAX');
  });
});

// ---------------------------------------------------------------------------
// 2. requires[].condition vs requires[].expression
// ---------------------------------------------------------------------------

describe('DSL canonical field: requires[].condition vs requires[].expression', () => {
  const celExpr = "state.status == 'ACTIVE'";

  function makeRequiresBehavior(requiresEntry: Record<string, unknown>) {
    return {
      ...makeBase(),
      behaviors: [
        {
          name: 'b',
          match: {
            operationId: 'updateThing',
            condition: 'true',
            requires: [requiresEntry],
          },
          emit: 'Evt',
        },
      ],
    };
  }

  it('canonical form "condition" parses correctly', () => {
    const config = validateBoundaryConfig(makeRequiresBehavior({
      name: 'isActive',
      condition: celExpr,
      error_code: 'NOT_ACTIVE',
      error_message: 'Must be active',
    }));
    const req = config.behaviors[0].match.requires![0];
    expect(req.condition).toBe(celExpr);
    expect(req.errorCode).toBe('NOT_ACTIVE');
  });

  it('legacy form "expression" parses to the same result as "condition"', () => {
    const config = validateBoundaryConfig(makeRequiresBehavior({
      name: 'isActive',
      expression: celExpr,
      error_code: 'NOT_ACTIVE',
      error_message: 'Must be active',
    }));
    const req = config.behaviors[0].match.requires![0];
    // Regardless of YAML field name, the TypeScript field is always "condition"
    expect(req.condition).toBe(celExpr);
  });

  it('"condition" and "expression" both produce identical RequiresGuard objects', () => {
    const conditionConfig = validateBoundaryConfig(makeRequiresBehavior({
      name: 'isActive',
      condition: celExpr,
      error_code: 'E',
      message: 'M',
    }));
    const expressionConfig = validateBoundaryConfig(makeRequiresBehavior({
      name: 'isActive',
      expression: celExpr,
      error_code: 'E',
      message: 'M',
    }));
    expect(conditionConfig.behaviors[0].match.requires![0]).toEqual(
      expressionConfig.behaviors[0].match.requires![0],
    );
  });

  it('throws BootError when neither "condition" nor "expression" is provided', () => {
    expect(() => validateBoundaryConfig(makeRequiresBehavior({
      name: 'isActive',
    }))).toThrow(BootError);
  });
});

// ---------------------------------------------------------------------------
// 3. postcondition string vs postcondition {expression: ...}
// ---------------------------------------------------------------------------

describe('DSL canonical field: postcondition string vs {expression} object', () => {
  const celExpr = 'state.balance >= 0';

  function makeBehaviorWithPostcondition(postconditionValue: unknown) {
    return {
      ...makeBase(),
      behaviors: [
        {
          name: 'b',
          match: { operationId: 'updateThing', condition: 'true' },
          emit: 'Evt',
          postcondition: postconditionValue,
        },
      ],
    };
  }

  it('canonical form (plain string) parses correctly', () => {
    const config = validateBoundaryConfig(makeBehaviorWithPostcondition(celExpr));
    expect(config.behaviors[0].postcondition).toBe(celExpr);
  });

  it('legacy form ({expression: ...}) parses to the same result as plain string', () => {
    const config = validateBoundaryConfig(makeBehaviorWithPostcondition({ expression: celExpr }));
    // Regardless of YAML form, the TypeScript field is always a string
    expect(config.behaviors[0].postcondition).toBe(celExpr);
  });

  it('plain string and {expression: ...} both produce identical postcondition values', () => {
    const stringConfig = validateBoundaryConfig(makeBehaviorWithPostcondition(celExpr));
    const objectConfig = validateBoundaryConfig(makeBehaviorWithPostcondition({ expression: celExpr }));
    expect(stringConfig.behaviors[0].postcondition).toEqual(objectConfig.behaviors[0].postcondition);
  });

  it('throws BootError when postcondition is an object without "expression" key', () => {
    expect(() => validateBoundaryConfig(makeBehaviorWithPostcondition({ wrongKey: celExpr }))).toThrow(BootError);
  });

  it('throws BootError when postcondition is neither string nor object', () => {
    expect(() => validateBoundaryConfig(makeBehaviorWithPostcondition(42))).toThrow(BootError);
  });
});
