import {
  boundaryConfigToInferenceInput,
  buildInferredSchema,
  extractStateRefs,
  ftArray,
  ftKnown,
  ftNarrowed,
  ftObject,
  ftUnknown,
  inferTypeFromCel,
  lintUnusedComputed,
  lub,
  recomputeComputedFields,
  type BoundaryInferenceInput,
} from '../../../src/dsl/schemaInference.js';
import { validateBoundaryConfig } from '../../../src/dsl/schema.js';

const emptyState = new Map();

function baseInput(overrides: Partial<BoundaryInferenceInput> = {}): BoundaryInferenceInput {
  return {
    boundary: 'Matrix',
    events: [],
    reducers: [],
    ...overrides,
  };
}

describe('schema inference type lattice', () => {
  it('merges nested arrays and objects while retaining confidence', () => {
    expect(lub(ftArray(ftKnown('integer')), ftArray(ftKnown('number')))).toEqual(
      ftArray(ftNarrowed('number'), 'known'),
    );
    expect(
      lub(
        ftObject({ id: ftKnown('string') }),
        ftObject({ id: ftKnown('string'), count: ftKnown('integer') }),
      ),
    ).toEqual(ftObject({ id: ftKnown('string'), count: ftKnown('integer') }));
    expect(lub(ftNarrowed('string'), ftKnown('string'))).toEqual(ftNarrowed('string'));
    expect(lub(ftUnknown(), ftObject({}))).toEqual(ftUnknown());
  });
});

describe('schema inference CEL edge forms', () => {
  it.each([
    [
      'event payload nested field',
      inferTypeFromCel(
        'event.payload.customer.name',
        { customer: ftObject({ name: ftKnown('string') }) },
        emptyState,
      ),
      ftKnown('string'),
    ],
    [
      'event payload without schema',
      inferTypeFromCel('event.payload.name', undefined, emptyState),
      ftUnknown(),
    ],
    [
      'event payload missing nested field',
      inferTypeFromCel(
        'event.payload.customer.missing',
        { customer: ftObject({ name: ftKnown('string') }) },
        emptyState,
      ),
      ftUnknown(),
    ],
    [
      'state direct field',
      inferTypeFromCel(
        'state.count',
        undefined,
        new Map([['/count', { type: ftKnown('integer'), sources: [] }]]),
      ),
      ftKnown('integer'),
    ],
    [
      'state nested field',
      inferTypeFromCel(
        'state.customer.name',
        undefined,
        new Map([['/customer', { type: ftObject({ name: ftKnown('string') }), sources: [] }]]),
      ),
      ftKnown('string'),
    ],
    [
      'state nested field through scalar',
      inferTypeFromCel(
        'state.customer.name',
        undefined,
        new Map([['/customer', { type: ftKnown('string'), sources: [] }]]),
      ),
      ftUnknown(),
    ],
    ['state missing field', inferTypeFromCel('state.missing', undefined, emptyState), ftUnknown()],
    ['unknown addition', inferTypeFromCel('true + 1', undefined, emptyState), ftUnknown()],
    ['multiple additions', inferTypeFromCel('1 + 2 + 3', undefined, emptyState), ftUnknown()],
    ['negative number', inferTypeFromCel('-1', undefined, emptyState), ftKnown('integer')],
    [
      'non-empty object literal',
      inferTypeFromCel('{id: 1}', undefined, emptyState),
      ftObject({}, 'narrowed'),
    ],
    ['empty object literal', inferTypeFromCel('{}', undefined, emptyState), ftObject({}, 'known')],
    [
      'array literal',
      inferTypeFromCel('[1, 2]', undefined, emptyState),
      ftArray(ftUnknown(), 'narrowed'),
    ],
    ['unrecognised expression', inferTypeFromCel('state[0]', undefined, emptyState), ftUnknown()],
  ] as const)('infers %s', (_label, actual, expected) => {
    expect(actual).toEqual(expected);
  });

  it('deduplicates textual state references, including references inside strings', () => {
    expect(extractStateRefs("'state.fake' + state.real + state.real + state.nested.value")).toEqual(
      ['fake', 'real', 'nested'],
    );
  });
});

describe('schema inference patch contributions', () => {
  it('handles every patch family without treating structural operations as writes', () => {
    const result = buildInferredSchema(
      baseInput({
        events: [
          { name: 'Changed', template: { source: '1' } },
          { name: 'Moved', patches: [{ op: 'replace', path: '/fromEvent', value: 'true' }] },
        ],
        reducers: [
          {
            on: 'Changed',
            patches: [
              { op: 'add', path: '/added', value: 'text' },
              { op: 'replace', path: '/replaced', value: 1.5 },
              { op: 'append', path: '/appended', value: true },
              { op: 'prepend', path: '/prepended', value: null },
              { op: 'increment', path: '/incremented', by: 1 },
              { op: 'merge', path: '/merged', value: {} },
              { op: 'upsert', path: '/upserted', key: 'id', value: {} },
              { op: 'remove', path: '/removed' },
              { op: 'move', from: '/source', path: '/moved' },
              { op: 'copy', from: '/source', path: '/copied' },
            ],
          },
        ],
      }),
    );

    expect(result.schema.get('/added')?.type).toEqual(ftUnknown());
    expect(result.schema.get('/replaced')?.type).toEqual(ftKnown('number'));
    expect(result.schema.get('/appended')?.type).toEqual(ftArray(ftKnown('boolean'), 'narrowed'));
    expect(result.schema.get('/prepended')?.type).toEqual(ftArray(ftKnown('null'), 'narrowed'));
    expect(result.schema.get('/incremented')?.type).toEqual(ftKnown('number'));
    expect(result.schema.get('/merged')?.type).toEqual(ftObject({}, 'narrowed'));
    expect(result.schema.get('/upserted')?.type).toEqual(ftObject({}, 'narrowed'));
    expect(result.schema.has('/removed')).toBe(false);
    expect(result.schema.has('/moved')).toBe(false);
    expect(result.schema.has('/copied')).toBe(false);
  });

  it('converts the canonical YAML boundary shape, including optional state and strictness', () => {
    const boundary = validateBoundaryConfig({
      boundary: 'Matrix',
      contract_path: '/matrix',
      event_catalog: [{ type: 'Created', payload_template: { id: '1' } }],
      reducers: [{ on: 'Created', patches: [{ op: 'replace', path: '/id', value: 1 }] }],
      behaviors: [],
      strict_schema: false,
      state: { computed: [], internal: [] },
    });
    expect(boundaryConfigToInferenceInput(boundary)).toMatchObject({
      boundary: 'Matrix',
      strict: false,
      state: { computed: [], internal: [] },
      events: [{ name: 'Created', template: { id: '1' } }],
    });
  });
});

describe('computed field dependency edge cases', () => {
  it('orders computed fields after non-computed dependencies', () => {
    const result = buildInferredSchema(
      baseInput({
        state: {
          computed: [
            { name: 'summary', formula: 'state.total', dependsOn: ['total'] },
            { name: 'total', formula: '1', dependsOn: ['amount'] },
          ],
        },
      }),
    );
    expect(result.computedOrder).toEqual(['total', 'summary']);
  });

  it('uses state-surface references when checking unused fields', () => {
    expect(
      lintUnusedComputed(
        [
          { name: 'visible', formula: '1', dependsOn: [] },
          { name: 'hidden', formula: '2', dependsOn: [] },
        ],
        { stateSurfaceNames: ['visible'] },
      ),
    ).toEqual(['Computed field "hidden" is declared but never read']);
    expect(lintUnusedComputed([], {})).toEqual([]);
  });

  it('recomputes only touched fields, preserves missing order entries, and normalizes null', () => {
    const calls: string[] = [];
    const state: Record<string, unknown> = { input: 1 };
    recomputeComputedFields(
      state,
      [{ name: 'value', formula: 'value', dependsOn: ['input'] }],
      ['unknown', 'value'],
      new Set(['/input', '']),
      {
        evaluate(formula) {
          calls.push(formula);
          return undefined;
        },
      },
    );
    expect(calls).toEqual(['value']);
    expect(state.value).toBeNull();
  });
});
