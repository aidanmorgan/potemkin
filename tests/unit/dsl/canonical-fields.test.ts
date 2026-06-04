/**
 * DSL canonical field-name acceptance tests.
 *
 * Verifies that:
 *  1. scripts: is removed — any boundary YAML containing scripts: halts boot with
 *     BOOT_ERR_REMOVED_SYNTAX (both code: and source: forms were removed together).
 *  2. requires[] accepts only the canonical "condition" field (the legacy
 *     "expression" alias was removed).
 *  3. postcondition accepts only the canonical plain CEL string (the legacy
 *     {expression: "..."} object form was removed).
 */

import { validateBoundaryConfig } from '../../../src/dsl/schema';
import { BootError } from '../../../src/errors';

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
// 2. requires[].condition (canonical only; legacy "expression" removed)
// ---------------------------------------------------------------------------

describe('DSL canonical field: requires[].condition', () => {
  const celExpr = "state.status == 'ACTIVE'";

  function makeRequiresBehavior(requiresEntry: Record<string, unknown>) {
    return {
      ...makeBase(),
      behaviors: [
        {
          name: 'b',
          match: { operationId: 'updateThing', condition: 'true', requires: [requiresEntry] },
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

  it('the removed legacy alias "expression" is rejected — only "condition" is accepted', () => {
    expect(() => validateBoundaryConfig(makeRequiresBehavior({
      name: 'isActive',
      expression: celExpr,
      error_code: 'NOT_ACTIVE',
    }))).toThrow(BootError);
  });

  it('throws BootError when "condition" is not provided', () => {
    expect(() => validateBoundaryConfig(makeRequiresBehavior({ name: 'isActive' }))).toThrow(BootError);
  });
});

// ---------------------------------------------------------------------------
// 3. postcondition: canonical plain string (legacy {expression} object removed)
// ---------------------------------------------------------------------------

describe('DSL canonical field: postcondition (plain string only)', () => {
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

  it('the removed legacy object form ({expression: ...}) is rejected', () => {
    expect(() => validateBoundaryConfig(makeBehaviorWithPostcondition({ expression: celExpr }))).toThrow(BootError);
  });

  it('throws BootError when postcondition is not a string', () => {
    expect(() => validateBoundaryConfig(makeBehaviorWithPostcondition(42))).toThrow(BootError);
  });
});
