import type {
  FiniteStateModel,
  GeneratedSequence,
  GenerationOptions,
  ModelTransition,
} from './types.js';

/** Breadth-first transition coverage suite for a finite Potemkin model. */
export function generateModelSequences(
  model: FiniteStateModel,
  options: GenerationOptions = {},
): readonly GeneratedSequence[] {
  const extraStates = Math.max(0, Math.floor(options.extraStates ?? 0));
  const maxDepth = Math.max(0, options.maxDepth ?? model.states.length + extraStates + 1);
  const byState = new Map<string, readonly ModelTransition[]>();
  for (const state of model.states)
    byState.set(
      state,
      model.transitions.filter((transition) => transition.from === state),
    );
  const queue: Array<{ state: string; steps: string[]; covered: string[] }> = [
    { state: model.initial, steps: [], covered: [] },
  ];
  const seen = new Set<string>();
  const sequences: GeneratedSequence[] = [];
  const negativeSequences: GeneratedSequence[] = [];
  const operations = [
    ...new Set(model.transitions.map((transition) => transition.operation)),
  ].sort();
  while (queue.length > 0) {
    const item = queue.shift()!;
    const key = `${item.state}|${item.steps.join('>')}`;
    if (seen.has(key) || item.steps.length > maxDepth) continue;
    seen.add(key);
    if (item.covered.length > 0)
      sequences.push({ steps: item.steps, coveredTransitions: item.covered });
    if (options.includeNegative === true && item.steps.length < maxDepth) {
      const enabled = new Set(
        (byState.get(item.state) ?? []).map((transition) => transition.operation),
      );
      for (const operation of operations) {
        if (!enabled.has(operation)) {
          negativeSequences.push({
            steps: [...item.steps, operation],
            coveredTransitions: [],
          });
        }
      }
    }
    for (const transition of byState.get(item.state) ?? []) {
      const transitionKey = transitionKeyOf(transition);
      queue.push({
        state: transition.to,
        steps: [...item.steps, transition.operation],
        covered: [...item.covered, transitionKey],
      });
    }
  }
  const uncovered = new Set(model.transitions.map(transitionKeyOf));
  const result: GeneratedSequence[] = [];
  for (const sequence of sequences) {
    const newlyCovered = sequence.coveredTransitions.filter((key) => uncovered.delete(key));
    if (newlyCovered.length > 0) result.push({ ...sequence, coveredTransitions: newlyCovered });
  }
  if (options.includeNegative !== true) return Object.freeze(result);

  const unique = new Set(result.map((sequence) => sequence.steps.join('\u0000')));
  for (const sequence of negativeSequences) {
    const key = sequence.steps.join('\u0000');
    if (!unique.has(key)) {
      unique.add(key);
      result.push(sequence);
    }
  }
  return Object.freeze(result);
}

/** W-method-shaped bounded suite: coverage paths plus distinguishing suffixes. */
export function generateWpSuite(
  model: FiniteStateModel,
  options: GenerationOptions = {},
): readonly GeneratedSequence[] {
  const base = generateModelSequences(model, options);
  const suffixes = distinguishingSuffixes(model);
  const output: GeneratedSequence[] = [];
  for (const sequence of base) {
    output.push(sequence);
    for (const suffix of suffixes) {
      if (sequence.steps.length + suffix.length > (options.maxDepth ?? Number.MAX_SAFE_INTEGER))
        continue;
      output.push({
        steps: [...sequence.steps, ...suffix],
        coveredTransitions: sequence.coveredTransitions,
      });
    }
  }
  return Object.freeze(output);
}

function distinguishingSuffixes(model: FiniteStateModel): readonly string[][] {
  const operations = [
    ...new Set(model.transitions.map((transition) => transition.operation)),
  ].sort();
  return operations.length === 0 ? [[]] : operations.map((operation) => [operation]);
}

function transitionKeyOf(transition: ModelTransition): string {
  return `${transition.from}:${transition.operation}->${transition.to}`;
}
