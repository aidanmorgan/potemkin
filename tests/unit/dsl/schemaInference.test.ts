/**
 * Tests for src/dsl/schemaInference.ts.
 *
 * Covers REQ-STATE-001..007 and REQ-PATCH-005.
 */

import {
  buildInferredSchema,
  inferTypeFromCel,
  extractStateRefs,
  lub,
  ftKnown,
  ftUnknown,
  ftNarrowed,
  lintUnusedComputed,
  recomputeComputedFields,
  type BoundaryInferenceInput,
} from '../../../src/dsl/schemaInference.js';
import { BootError } from '../../../src/errors.js';

describe('CEL textual type inference (REQ-STATE-001 AC-001.1)', () => {
  const empty = new Map();
  it("'literal' → known string", () => {
    expect(inferTypeFromCel("'hi'", undefined, empty)).toEqual(ftKnown('string'));
  });
  it('42 → known integer', () => {
    expect(inferTypeFromCel('42', undefined, empty)).toEqual(ftKnown('integer'));
  });
  it('42.5 → known number', () => {
    expect(inferTypeFromCel('42.5', undefined, empty)).toEqual(ftKnown('number'));
  });
  it('true / false → known boolean', () => {
    expect(inferTypeFromCel('true', undefined, empty)).toEqual(ftKnown('boolean'));
    expect(inferTypeFromCel('false', undefined, empty)).toEqual(ftKnown('boolean'));
  });
  it('null → known null', () => {
    expect(inferTypeFromCel('null', undefined, empty)).toEqual(ftKnown('null'));
  });
  it('length(x), size(x) → integer', () => {
    expect(inferTypeFromCel('length(state.items)', undefined, empty)).toEqual(ftKnown('integer'));
    expect(inferTypeFromCel('size(state.items)', undefined, empty)).toEqual(ftKnown('integer'));
  });
  it('sum(...) → number', () => {
    expect(inferTypeFromCel('sum(state.lineItems[*].total)', undefined, empty)).toEqual(
      ftKnown('number'),
    );
  });
  it('event.payload.X resolves via the event schema', () => {
    const ev = { foo: ftKnown('string') };
    expect(inferTypeFromCel('event.payload.foo', ev, empty)).toEqual(ftKnown('string'));
  });
  it('state.X resolves via the state schema', () => {
    const state = new Map([['/score', { type: ftKnown('integer'), sources: [] }]]);
    expect(inferTypeFromCel('state.score', undefined, state)).toEqual(ftKnown('integer'));
  });
  it('ternary picks LUB of both branches', () => {
    expect(inferTypeFromCel("cond ? 1 : 2.5", undefined, empty)).toEqual(ftNarrowed('number'));
  });
  it('string + anything → string', () => {
    expect(inferTypeFromCel("'a' + 1", undefined, empty)).toEqual(ftKnown('string'));
  });
  it('integer + integer → integer; integer + number → number narrowed', () => {
    expect(inferTypeFromCel('1 + 2', undefined, empty)).toEqual(ftKnown('integer'));
    expect(inferTypeFromCel('1 + 2.5', undefined, empty)).toEqual(ftNarrowed('number'));
  });
});

describe('LUB', () => {
  it('integer + number → number narrowed', () => {
    expect(lub(ftKnown('integer'), ftKnown('number'))).toEqual(ftNarrowed('number'));
  });
  it('string + integer → unknown', () => {
    expect(lub(ftKnown('string'), ftKnown('integer'))).toEqual(ftUnknown());
  });
  it('unknown propagates', () => {
    expect(lub(ftKnown('string'), ftUnknown())).toEqual(ftUnknown());
  });
});

describe('extractStateRefs (REQ-STATE-005 AC-005.1)', () => {
  it('extracts top-level state references', () => {
    expect(extractStateRefs("state.totalValue + state.itemCount")).toEqual(
      expect.arrayContaining(['totalValue', 'itemCount']),
    );
  });
  it('extracts head of nested access', () => {
    expect(extractStateRefs('state.lineItems[0].sku')).toEqual(['lineItems']);
  });
  it('extracts both branches of ternary', () => {
    expect(extractStateRefs('state.a > 0 ? state.b : state.c').sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('buildInferredSchema — happy path (REQ-STATE-001, 002)', () => {
  it('derives schema from event templates and reducer patches', () => {
    const input: BoundaryInferenceInput = {
      boundary: 'Lead',
      events: [
        {
          name: 'LeadCreated',
          template: { agentId: "'agent-1'", value: '100' },
        },
      ],
      reducers: [
        {
          on: 'LeadCreated',
          patches: [
            { op: 'replace', path: '/id', value: 'event.aggregateId' },
            { op: 'replace', path: '/status', value: "'NEW'" },
            { op: 'replace', path: '/agentId', value: 'event.payload.agentId' },
          ],
        },
      ],
    };
    const result = buildInferredSchema(input);
    expect(result.schema.get('/status')?.type.kind).toBe('string');
    expect(result.schema.get('/agentId')?.type.kind).toBe('string');
  });

  it('merges declared internal/computed into the schema', () => {
    const input: BoundaryInferenceInput = {
      boundary: 'Opportunity',
      events: [
        {
          name: 'LineItemAdded',
          template: { qty: '5', unitPrice: '10' },
        },
      ],
      reducers: [
        {
          on: 'LineItemAdded',
          patches: [
            { op: 'append', path: '/lineItems', value: { qty: 'event.payload.qty' } },
          ],
        },
      ],
      state: {
        computed: [
          {
            name: 'totalValue',
            formula: 'sum(state.lineItems[*].qty)',
            dependsOn: ['lineItems'],
          },
        ],
        internal: [
          { name: 'audit', type: { kind: 'object', confidence: 'known', fields: {} } },
        ],
      },
    };
    const result = buildInferredSchema(input);
    expect(result.schema.get('/audit')?.type.kind).toBe('object');
    expect(result.schema.get('/totalValue')?.type.kind).toBe('number');
    expect(result.computedOrder).toContain('totalValue');
  });
});

function expectBootCode(fn: () => unknown, code: string): void {
  let caught: BootError | null = null;
  try {
    fn();
  } catch (e) {
    if (e instanceof BootError) caught = e;
  }
  expect(caught?.code).toBe(code);
}

describe('Schema-inference fixed-point cap (REQ-STATE-003, AC-G1.1)', () => {
  // The inference loop is a monotone fixed-point computation: every write LUBs
  // its contribution into the accumulated schema, so each field type only ever
  // moves up the (shallow, finite-height) lattice toward `unknown`. A `state.X`
  // self-reference resolves against the PREVIOUS iteration's schema, which is
  // empty on the first pass, so any field whose type derives from another state
  // field collapses to `unknown` immediately. This guarantees convergence well
  // within the 4-iteration cap (MAX_INFERENCE_ITERATIONS).
  //
  // The cap therefore protects against runaway iteration without ever
  // exceeding itself for valid inputs. These tests exercise the cyclic /
  // forward-referential shapes the cap exists to bound and assert that the
  // build terminates with a stable schema rather than looping.

  it('mutually-cyclic event-payload template references terminate at a stable schema', () => {
    // a's template type references b; b's references a. Cyclic by construction.
    const result = buildInferredSchema({
      boundary: 'Cyclic',
      events: [
        { name: 'E', template: { a: 'event.payload.b', b: 'event.payload.a' } },
      ],
      reducers: [
        {
          on: 'E',
          patches: [
            { op: 'replace', path: '/a', value: 'state.b' },
            { op: 'replace', path: '/b', value: 'state.a' },
          ],
        },
      ],
    });
    // Cyclic state self-references cannot be resolved → both settle at unknown.
    expect(result.schema.get('/a')?.type.kind).toBe('unknown');
    expect(result.schema.get('/b')?.type.kind).toBe('unknown');
  });

  it('a long forward-referential reducer chain terminates within the cap', () => {
    // /f0 ← event payload; /f1 ← state.f0; /f2 ← state.f1; ... a chain far
    // longer than the iteration cap. It must still terminate (no throw, no
    // hang) and produce a stable schema entry for every field.
    const patches: { op: 'replace'; path: string; value: string }[] = [
      { op: 'replace', path: '/f0', value: 'event.payload.seed' },
    ];
    for (let n = 1; n <= 12; n++) {
      patches.push({ op: 'replace', path: `/f${n}`, value: `state.f${n - 1}` });
    }
    const result = buildInferredSchema({
      boundary: 'Chain',
      events: [{ name: 'E', template: { seed: '7' } }],
      reducers: [{ on: 'E', patches }],
    });
    for (let n = 0; n <= 12; n++) {
      expect(result.schema.has(`/f${n}`)).toBe(true);
    }
  });
});

describe('Computed field cycles (REQ-STATE-004)', () => {
  it('self-cycles are rejected', () => {
    expectBootCode(
      () =>
        buildInferredSchema({
          boundary: 'X',
          events: [],
          reducers: [],
          state: {
            computed: [
              { name: 'a', formula: 'state.a + 1', dependsOn: ['a'] },
            ],
          },
        }),
      'BOOT_ERR_COMPUTED_FIELD_CYCLE',
    );
  });

  it('A → B → C → A cycle is detected and reported in cycle-order (AC-G1.2)', () => {
    let caught: BootError | null = null;
    try {
      buildInferredSchema({
        boundary: 'X',
        events: [],
        reducers: [],
        state: {
          computed: [
            { name: 'a', formula: 'state.b', dependsOn: ['b'] },
            { name: 'b', formula: 'state.c', dependsOn: ['c'] },
            { name: 'c', formula: 'state.a', dependsOn: ['a'] },
          ],
        },
      });
    } catch (e) {
      if (e instanceof BootError) caught = e;
    }
    expect(caught?.code).toBe('BOOT_ERR_COMPUTED_FIELD_CYCLE');
    // Cycle path is reported in dependency order, closing back on the start.
    const cycle = (caught?.details as { cycle?: string[] } | undefined)?.cycle;
    expect(cycle).toEqual(['a', 'b', 'c', 'a']);
    // The human-readable message renders the same ordered path.
    expect(caught?.message).toContain('a → b → c → a');
  });

  it('A → B → A cycle is reported in cycle-order', () => {
    let caught: BootError | null = null;
    try {
      buildInferredSchema({
        boundary: 'X',
        events: [],
        reducers: [],
        state: {
          computed: [
            { name: 'a', formula: 'state.b', dependsOn: ['b'] },
            { name: 'b', formula: 'state.a', dependsOn: ['a'] },
          ],
        },
      });
    } catch (e) {
      if (e instanceof BootError) caught = e;
    }
    expect(caught?.code).toBe('BOOT_ERR_COMPUTED_FIELD_CYCLE');
    expect(caught?.message).toMatch(/a.+b/);
  });
});

describe('Computed field free-variable check (REQ-STATE-005)', () => {
  it('strict mode rejects unlisted state references', () => {
    expectBootCode(
      () =>
        buildInferredSchema({
          boundary: 'X',
          events: [],
          reducers: [],
          state: {
            computed: [
              {
                name: 'avg',
                formula: 'state.total / state.count',
                dependsOn: ['total'], // missing 'count'
              },
            ],
          },
        }),
      'BOOT_ERR_COMPUTED_FIELD_INCOMPLETE_DEPS',
    );
  });

  it('non-strict mode downgrades to a warning', () => {
    const result = buildInferredSchema({
      boundary: 'X',
      events: [],
      reducers: [],
      strict: false,
      state: {
        computed: [
          {
            name: 'avg',
            formula: 'state.total / state.count',
            dependsOn: ['total'],
          },
        ],
      },
    });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/count/);
  });
});

describe('Reducer cannot write computed paths (REQ-PATCH-005)', () => {
  const baseInput = (extraReducerPatch: { op: 'replace' | 'remove'; path: string }): BoundaryInferenceInput => ({
    boundary: 'X',
    events: [{ name: 'E', template: { foo: '1' } }],
    reducers: [
      {
        on: 'E',
        patches: [
          { op: 'replace', path: '/foo', value: 'event.payload.foo' },
          extraReducerPatch as never,
        ],
      },
    ],
    state: {
      computed: [
        { name: 'summary', formula: "'x'", dependsOn: [] },
      ],
    },
  });

  it('replace to a computed path is rejected', () => {
    expectBootCode(
      () => buildInferredSchema(baseInput({ op: 'replace', path: '/summary' })),
      'BOOT_ERR_COMPUTED_FIELD_WRITE',
    );
  });

  it('replace to a nested path under a computed root is rejected', () => {
    expectBootCode(
      () => buildInferredSchema(baseInput({ op: 'replace', path: '/summary/inner' })),
      'BOOT_ERR_COMPUTED_FIELD_WRITE',
    );
  });

  it('remove of a computed path is rejected', () => {
    expectBootCode(
      () => buildInferredSchema(baseInput({ op: 'remove', path: '/summary' })),
      'BOOT_ERR_COMPUTED_FIELD_WRITE',
    );
  });
});

describe('Computed shadows inferred (REQ-STATE-002 AC-002.3)', () => {
  it('computed name colliding with an inferred event-derived field throws', () => {
    expectBootCode(
      () =>
        buildInferredSchema({
          boundary: 'X',
          events: [{ name: 'E', template: { status: "'NEW'" } }],
          reducers: [
            { on: 'E', patches: [{ op: 'replace', path: '/status', value: "'NEW'" }] },
          ],
          state: {
            computed: [{ name: 'status', formula: "'X'", dependsOn: [] }],
          },
        }),
      'BOOT_ERR_COMPUTED_FIELD_SHADOWS_INFERRED',
    );
  });
});

describe('Lint unused computed fields (REQ-STATE-007)', () => {
  it('emits a warning when a computed field is never referenced', () => {
    const warnings = lintUnusedComputed(
      [
        { name: 'a', formula: '1', dependsOn: [] },
        { name: 'b', formula: '2', dependsOn: [] },
      ],
      { responseBodies: ['state.a'] },
    );
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/"b"/);
  });
});

describe('recomputeComputedFields (REQ-STATE-006)', () => {
  it('respects topological order', () => {
    const calls: string[] = [];
    const ev = {
      evaluate(formula: string, ctx: { state: Record<string, unknown> }): unknown {
        calls.push(formula);
        if (formula === 'state.a + state.b') return (ctx.state['a'] as number) + (ctx.state['b'] as number);
        if (formula === '1') return 1;
        if (formula === '2') return 2;
        return null;
      },
    };
    const computed = [
      { name: 'a', formula: '1', dependsOn: ['x'] },
      { name: 'b', formula: '2', dependsOn: ['x'] },
      { name: 'c', formula: 'state.a + state.b', dependsOn: ['a', 'b'] },
    ];
    const state: Record<string, unknown> = { x: 1 };
    recomputeComputedFields(state, computed, ['a', 'b', 'c'], new Set(['/x']), ev);
    expect(state).toEqual({ x: 1, a: 1, b: 2, c: 3 });
    // c must be computed AFTER a,b
    expect(calls.indexOf('state.a + state.b')).toBeGreaterThan(calls.indexOf('1'));
  });

  it('skips computed fields whose deps are not touched', () => {
    const ev = {
      evaluate(): unknown {
        throw new Error('should not be called');
      },
    };
    const computed = [{ name: 'x', formula: '1', dependsOn: ['otherField'] }];
    recomputeComputedFields({}, computed, ['x'], new Set(['/unrelated']), ev);
    // no throw → success (evaluator not called)
  });
});
