/**
 * Unit tests for C2: parameter substitution engine + type validation.
 *
 * Coverage:
 *  1. {{token}} substituted in a string value
 *  2. {{token}} substituted in a reducer patch path (JSON-Pointer key)
 *  3. {{token}} substituted in a behavior/event name (boundary name string)
 *  4. Missing required parameter → BOOT_ERR_DSL_SYNTAX naming the parameter
 *  5. Type mismatch (string arg for number parameter) → BOOT_ERR_DSL_SYNTAX
 *  6. Unknown {{token}} (no declared parameter) → BOOT_ERR_DSL_SYNTAX
 *  7. Unknown arg supplied (not in parameters block) → BOOT_ERR_DSL_SYNTAX
 *  8. CEL ${...} expressions are left byte-for-byte unchanged
 *  9. Default value applied when arg is omitted
 * 10. Exact single-token match returns native typed value (number, boolean)
 */

import { substituteParameters, substituteTokens } from '../../../src/dsl/parameterSubstitution';
import { BootError } from '../../../src/errors';
import type { ComponentDefinition } from '../../../src/dsl/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ComponentDefinition for test fixtures. */
function makeComponent(overrides: Partial<ComponentDefinition> = {}): ComponentDefinition {
  return {
    kind: 'component',
    name: 'TestEntity',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Substitution in a string value
// ---------------------------------------------------------------------------

describe('substituteParameters — string value substitution', () => {
  it('replaces a {{token}} in an event catalog entry type', () => {
    const component = makeComponent({
      parameters: {
        eventType: { type: 'string' },
      },
      eventCatalog: [
        { type: '{{eventType}}Created', payloadTemplate: {} },
      ],
    });

    const result = substituteParameters(component, { eventType: 'Document' });

    expect(result.eventCatalog![0]!.type).toBe('DocumentCreated');
  });

  it('replaces a {{token}} embedded in a payload_template value', () => {
    const component = makeComponent({
      parameters: {
        defaultStatus: { type: 'string' },
      },
      eventCatalog: [
        { type: 'EntityCreated', payloadTemplate: { status: "'{{defaultStatus}}'" } },
      ],
    });

    const result = substituteParameters(component, { defaultStatus: 'ACTIVE' });

    expect(result.eventCatalog![0]!.payloadTemplate['status']).toBe("'ACTIVE'");
  });
});

// ---------------------------------------------------------------------------
// 2. Substitution in a reducer patch path (JSON-Pointer string)
// ---------------------------------------------------------------------------

describe('substituteParameters — reducer path substitution', () => {
  it('replaces {{token}} in a reducer patch path', () => {
    const component = makeComponent({
      parameters: {
        statusField: { type: 'string', default: 'status' },
      },
      eventCatalog: [
        { type: 'DocumentArchived', payloadTemplate: {} },
      ],
      reducers: [
        {
          on: 'DocumentArchived',
          patches: [
            { op: 'replace', path: '/{{statusField}}', value: "'ARCHIVED'" },
          ],
        },
      ],
    });

    const result = substituteParameters(component, { statusField: 'archivalStatus' });

    expect(result.reducers![0]!.patches![0]!.path).toBe('/archivalStatus');
  });

  it('uses the declared default when no arg is supplied for the patch path token', () => {
    const component = makeComponent({
      parameters: {
        statusField: { type: 'string', default: 'status' },
      },
      eventCatalog: [
        { type: 'DocumentArchived', payloadTemplate: {} },
      ],
      reducers: [
        {
          on: 'DocumentArchived',
          patches: [
            { op: 'replace', path: '/{{statusField}}', value: "'ARCHIVED'" },
          ],
        },
      ],
    });

    const result = substituteParameters(component, {});

    expect(result.reducers![0]!.patches![0]!.path).toBe('/status');
  });
});

// ---------------------------------------------------------------------------
// 3. Substitution in a boundary/event name (behavior name string)
// ---------------------------------------------------------------------------

describe('substituteParameters — boundary/event name substitution', () => {
  it('replaces {{token}} in a behavior match.operationId', () => {
    const component = makeComponent({
      parameters: {
        operationPrefix: { type: 'string' },
      },
      behaviors: [
        {
          name: '{{operationPrefix}}Create',
          match: {
            operationId: '{{operationPrefix}}CreateOp',
            condition: 'true',
          },
          emit: 'EntityCreated',
        },
      ],
    });

    const result = substituteParameters(component, { operationPrefix: 'Document' });

    expect(result.behaviors![0]!.name).toBe('DocumentCreate');
    expect(result.behaviors![0]!.match.operationId).toBe('DocumentCreateOp');
  });
});

// ---------------------------------------------------------------------------
// 4. Missing required parameter → error
// ---------------------------------------------------------------------------

describe('substituteParameters — missing required parameter', () => {
  it('throws BOOT_ERR_DSL_SYNTAX naming the missing required parameter', () => {
    const component = makeComponent({
      parameters: {
        initialStatus: { type: 'string', required: true },
      },
    });

    expect(() => substituteParameters(component, {})).toThrow(
      expect.objectContaining({
        code: 'BOOT_ERR_DSL_SYNTAX',
        message: expect.stringContaining('initialStatus'),
      }),
    );
  });

  it('error is a BootError instance', () => {
    const component = makeComponent({
      parameters: {
        requiredParam: { type: 'number', required: true },
      },
    });

    expect(() => substituteParameters(component, {})).toThrow(BootError);
  });
});

// ---------------------------------------------------------------------------
// 5. Type mismatch
// ---------------------------------------------------------------------------

describe('substituteParameters — type mismatch', () => {
  it('throws BOOT_ERR_DSL_SYNTAX when a string is supplied for a number parameter', () => {
    const component = makeComponent({
      parameters: {
        maxRetries: { type: 'number', default: 3 },
      },
    });

    expect(() =>
      substituteParameters(component, { maxRetries: 'three' }),
    ).toThrow(
      expect.objectContaining({
        code: 'BOOT_ERR_DSL_SYNTAX',
        message: expect.stringContaining('maxRetries'),
      }),
    );
  });

  it('throws BOOT_ERR_DSL_SYNTAX when a number is supplied for a boolean parameter', () => {
    const component = makeComponent({
      parameters: {
        isEnabled: { type: 'boolean' },
      },
    });

    expect(() =>
      substituteParameters(component, { isEnabled: 1 as unknown as boolean }),
    ).toThrow(
      expect.objectContaining({
        code: 'BOOT_ERR_DSL_SYNTAX',
        message: expect.stringContaining('isEnabled'),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Unknown {{token}} in a string leaf
// ---------------------------------------------------------------------------

describe('substituteParameters — unknown token in string leaf', () => {
  it('throws BOOT_ERR_DSL_SYNTAX naming the unknown token when encountered in eventCatalog', () => {
    const component = makeComponent({
      parameters: {
        knownParam: { type: 'string', default: 'value' },
      },
      eventCatalog: [
        { type: '{{unknownToken}}Event', payloadTemplate: {} },
      ],
    });

    expect(() => substituteParameters(component, {})).toThrow(
      expect.objectContaining({
        code: 'BOOT_ERR_DSL_SYNTAX',
        message: expect.stringContaining('unknownToken'),
      }),
    );
  });

  it('substituteTokens directly throws BOOT_ERR_DSL_SYNTAX for an unknown token', () => {
    const resolved = new Map<string, string | number | boolean>([['known', 'x']]);

    expect(() =>
      substituteTokens('prefix-{{missing}}-suffix', resolved, 'MyComponent'),
    ).toThrow(
      expect.objectContaining({
        code: 'BOOT_ERR_DSL_SYNTAX',
        message: expect.stringContaining('missing'),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Unknown arg (not in parameters block)
// ---------------------------------------------------------------------------

describe('substituteParameters — unknown arg supplied', () => {
  it('throws BOOT_ERR_DSL_SYNTAX when an arg is not declared in the parameters block', () => {
    const component = makeComponent({
      parameters: {
        knownParam: { type: 'string' },
      },
    });

    expect(() =>
      substituteParameters(component, { knownParam: 'ok', unknownExtra: 'bad' }),
    ).toThrow(
      expect.objectContaining({
        code: 'BOOT_ERR_DSL_SYNTAX',
        message: expect.stringContaining('unknownExtra'),
      }),
    );
  });

  it('throws BOOT_ERR_DSL_SYNTAX when args are supplied to a component with no parameters block', () => {
    const component = makeComponent(); // no parameters

    expect(() =>
      substituteParameters(component, { someArg: 'value' }),
    ).toThrow(
      expect.objectContaining({
        code: 'BOOT_ERR_DSL_SYNTAX',
        message: expect.stringContaining('someArg'),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 8. CEL ${...} expressions are left unchanged
// ---------------------------------------------------------------------------

describe('substituteParameters — CEL ${...} expressions are untouched', () => {
  it('leaves ${event.x} unchanged while substituting {{param}}', () => {
    const component = makeComponent({
      parameters: {
        statusField: { type: 'string' },
      },
      reducers: [
        {
          on: 'EntityUpdated',
          patches: [
            {
              op: 'replace',
              // Contains both a CEL expression and a {{param}} token.
              path: '/{{statusField}}',
              value: "${event.payload.newStatus}",
            },
          ],
        },
      ],
    });

    const result = substituteParameters(component, { statusField: 'currentStatus' });

    expect(result.reducers![0]!.patches![0]!.path).toBe('/currentStatus');
    // CEL value must be byte-for-byte identical — no substitution of ${...}.
    expect(result.reducers![0]!.patches![0]!.value).toBe('${event.payload.newStatus}');
  });

  it('leaves a mixed "${event.x} and {{param}}" string with only {{param}} changed', () => {
    const resolved = new Map<string, string | number | boolean>([['param', 'replaced']]);
    const result = substituteTokens('${event.x} and {{param}}', resolved, 'Comp');
    expect(result).toBe('${event.x} and replaced');
  });

  it('an exact "{{name}}" is replaced but "${ }" is not matched even when it looks similar', () => {
    const resolved = new Map<string, string | number | boolean>([['name', 'ok']]);
    const celLike = '${name}';
    // substituteTokens must not touch ${name}
    expect(substituteTokens(celLike, resolved, 'Comp')).toBe('${name}');
  });

  it('leaves a brace-leading CEL map literal ${{...}} byte-for-byte unchanged', () => {
    // This form (a CEL object/map literal interpolation) contains a literal
    // "{{" that must NOT be treated as a parameter token. The repo uses it in
    // reducer values, e.g. ${{'amount': event.payload.amount}}.
    const resolved = new Map<string, string | number | boolean>([['statusField', 'x']]);
    const cel = "${{'amount': event.payload.amount}}";
    expect(substituteTokens(cel, resolved, 'Comp')).toBe(cel);
  });

  it('leaves an empty CEL map literal ${{}} unchanged', () => {
    const resolved = new Map<string, string | number | boolean>([['p', 'v']]);
    expect(substituteTokens('${{}}', resolved, 'Comp')).toBe('${{}}');
  });

  it('substitutes a {{token}} OUTSIDE a CEL map literal while leaving the literal intact', () => {
    const resolved = new Map<string, string | number | boolean>([['field', 'qty']]);
    const mixed = "/{{field}} = ${{'amount': event.payload.amount}}";
    expect(substituteTokens(mixed, resolved, 'Comp')).toBe(
      "/qty = ${{'amount': event.payload.amount}}",
    );
  });

  it('does NOT throw on a {{...}} that sits inside a CEL span even if it is not a declared parameter', () => {
    // Before the fix this threw BOOT_ERR_DSL_SYNTAX for the unknown "token"
    // 'amount': event.payload.amount. It must be left untouched, not rejected.
    const component = makeComponent({
      parameters: { statusField: { type: 'string' } },
      reducers: [
        {
          on: 'EntityUpdated',
          patches: [{ op: 'replace', path: '/{{statusField}}', value: "${{'amount': event.payload.amount}}" }],
        },
      ],
    });
    const result = substituteParameters(component, { statusField: 'currentStatus' });
    expect(result.reducers![0]!.patches![0]!.path).toBe('/currentStatus');
    expect(result.reducers![0]!.patches![0]!.value).toBe("${{'amount': event.payload.amount}}");
  });
});

// ---------------------------------------------------------------------------
// 9. Default value applied when arg is omitted
// ---------------------------------------------------------------------------

describe('substituteParameters — default values', () => {
  it('applies the string default when no arg is supplied', () => {
    const component = makeComponent({
      parameters: {
        prefix: { type: 'string', default: 'default_prefix' },
      },
      eventCatalog: [
        { type: '{{prefix}}_Event', payloadTemplate: {} },
      ],
    });

    const result = substituteParameters(component, {});

    expect(result.eventCatalog![0]!.type).toBe('default_prefix_Event');
  });

  it('arg overrides the default', () => {
    const component = makeComponent({
      parameters: {
        prefix: { type: 'string', default: 'default_prefix' },
      },
      eventCatalog: [
        { type: '{{prefix}}_Event', payloadTemplate: {} },
      ],
    });

    const result = substituteParameters(component, { prefix: 'custom' });

    expect(result.eventCatalog![0]!.type).toBe('custom_Event');
  });
});

// ---------------------------------------------------------------------------
// 10. Exact single-token substitution preserves native type
// ---------------------------------------------------------------------------

describe('substituteParameters — exact-token native type preservation', () => {
  it('an exact {{name}} number token returns a number, not a string', () => {
    const resolved = new Map<string, string | number | boolean>([['count', 42]]);
    const result = substituteTokens('{{count}}', resolved, 'Comp');
    expect(result).toBe(42);
    expect(typeof result).toBe('number');
  });

  it('an exact {{name}} boolean token returns a boolean', () => {
    const resolved = new Map<string, string | number | boolean>([['flag', false]]);
    const result = substituteTokens('{{flag}}', resolved, 'Comp');
    expect(result).toBe(false);
    expect(typeof result).toBe('boolean');
  });

  it('a {{name}} embedded in a larger string coerces the number to string', () => {
    const resolved = new Map<string, string | number | boolean>([['count', 7]]);
    const result = substituteTokens('retry-{{count}}-times', resolved, 'Comp');
    expect(result).toBe('retry-7-times');
    expect(typeof result).toBe('string');
  });
});
