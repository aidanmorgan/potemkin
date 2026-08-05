import { createCelEvaluator } from '../../../src/cel/evaluator.js';
import { CelPhase } from '../../../src/cel/phases.js';
import { defineHelper } from '../../../src/authoring/helpers.js';
import { defineSimulation, simulation } from '../../../src/authoring/builders.js';
import { helperName } from '../../../src/domain/references.js';

describe('TypeScript helper model', () => {
  it('keeps the helper callable for TypeScript and exposes a runtime definition', () => {
    const sourceLabel = defineHelper(
      helperName('sourceLabel'),
      (source: string) => `source:${source}`,
    );

    expect(sourceLabel('typescript')).toBe('source:typescript');
    expect(sourceLabel.definition.name).toBe('sourceLabel');
    expect(sourceLabel.definition.invoke(['yaml'])).toBe('source:yaml');
  });

  it('registers the same definition as a CEL function', () => {
    const add = defineHelper(
      helperName('addValues'),
      (left: number, right: number) => left + right,
    );
    const evaluator = createCelEvaluator({
      custom: new Map([
        [add.definition.name, (args) => add.definition.invoke(args as readonly [number, number])],
      ]),
    });

    expect(evaluator.evaluate('addValues(2, 3)', {}, CelPhase.EventHydration)).toBe(5);
  });

  it('enforces declared phases and rejects reducer execution', () => {
    const responseOnly = defineHelper(
      helperName('responseOnly'),
      (value: string) => value.toUpperCase(),
      { phases: ['response'] },
    );

    expect(responseOnly.definition.invoke(['ok'], CelPhase.Response)).toBe('OK');
    expect(() => responseOnly.definition.invoke(['ok'], CelPhase.EventHydration)).toThrow(
      'not allowed in phase "event-hydration"',
    );
    expect(() => responseOnly.definition.invoke(['ok'], CelPhase.Reducer)).toThrow(
      'not allowed in phase "reducer"',
    );
  });

  it('bounds helper inputs and rejects invalid execution budgets', () => {
    expect(() =>
      defineHelper(helperName('invalidBudget'), (value: string) => value, { maxDurationMs: 1_001 }),
    ).toThrow(/duration between 1 and 1000ms/);

    const bounded = defineHelper(helperName('boundedInput'), (...values: string[]) =>
      values.join(''),
    );
    expect(() => bounded.definition.invoke(Array.from({ length: 33 }, () => 'x'))).toThrow(
      'too many arguments',
    );
  });

  it('stores helpers on the canonical simulation definition', () => {
    const sourceLabel = defineHelper(helperName('sourceLabel'), (source: string) => source);
    const definition = simulation().helper(sourceLabel).build();

    expect(definition.helpers).toEqual([sourceLabel.definition]);
  });

  it('does not expose the broad runtime helper shape to TypeScript definitions', () => {
    const invalid = defineSimulation({
      boundaries: [],
      helpers: [
        {
          // @ts-expect-error Simulation definitions require branded TypeScript helper definitions.
          name: 'raw-helper',
          invoke: () => 'value',
        },
      ],
    });
    expect(invalid.helpers).toHaveLength(1);
  });

  it('rejects names which cannot be called by CEL', () => {
    expect(() => helperName('not-a-cel-name')).toThrow(/CEL identifier/);
  });

  it('validates direct TypeScript results as JSON values', () => {
    const invalid = defineHelper(helperName('invalidResult'), () => undefined as never);

    expect(() => invalid()).toThrow(/must return a JSON value/);
  });

  it('enforces the synchronous execution budget', () => {
    const bounded = defineHelper(
      helperName('slowHelper'),
      () => {
        const startedAt = performance.now();
        while (performance.now() - startedAt < 5) {
          // Deliberately exceed the one-millisecond authoring budget.
        }
        return 'finished';
      },
      { maxDurationMs: 1 },
    );

    expect(() => bounded()).toThrow(/exceeded its 1ms execution budget/);
  });
});
