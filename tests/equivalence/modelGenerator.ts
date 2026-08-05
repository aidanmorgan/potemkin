import type { JsonObject } from '../../src/contracts/value.js';
import type {
  Transition,
  TransitionMachine,
  TransitionModel,
} from '../../src/model/transitionModel.js';

export interface ModelDrivenStep {
  readonly operation: string;
  readonly from: string | '*';
  readonly to: string | 'UNKNOWN';
  readonly guardCel: string | null;
  readonly input: JsonObject;
  readonly targetRef?: string;
  readonly negative?: boolean;
}

export interface ModelDrivenSequence {
  readonly aggregate: string;
  readonly steps: readonly ModelDrivenStep[];
  readonly finalState: string;
  readonly coveredStates: readonly string[];
  readonly coveredTransitions: readonly string[];
}

export interface ModelDrivenGenerationOptions {
  readonly maxDepth?: number;
  /** Implementation-state bound used to size the W/Wp distinguishing suffixes. */
  readonly m?: number;
  readonly includeNegative?: boolean;
}

export interface ModelCoverage {
  readonly states: readonly string[];
  readonly transitions: readonly string[];
}

interface QueueItem {
  readonly state: string;
  readonly steps: readonly ModelDrivenStep[];
  readonly coveredStates: readonly string[];
  readonly coveredTransitions: readonly string[];
}

/** Generate positive and (optionally) negative sequences from MODEL1 only. */
export function generateTransitionModelSequences(
  model: TransitionModel,
  options: ModelDrivenGenerationOptions = {},
): readonly ModelDrivenSequence[] {
  return Object.freeze(
    model.machines.flatMap((machine) => generateMachineSequences(machine, options)),
  );
}

/**
 * Generate a bounded W/Wp-shaped suite from the same MODEL1 transitions.
 * Suffixes are valid paths from the sequence's final state, so positive suite
 * members remain executable by the dual runner.
 */
export function generateTransitionModelWpSuite(
  model: TransitionModel,
  options: ModelDrivenGenerationOptions = {},
): readonly ModelDrivenSequence[] {
  const output: ModelDrivenSequence[] = [];
  for (const machine of model.machines) {
    const baseDepth = Math.min(
      options.maxDepth ?? machine.states.length + 1,
      machine.states.length + 1,
    );
    const base = generateMachineSequences(machine, {
      ...options,
      maxDepth: baseDepth,
      includeNegative: false,
    });
    const suffixDepth = Math.max(
      1,
      (options.m ?? machine.states.length) - machine.states.length + 1,
    );
    for (const sequence of base) {
      output.push(sequence);
      extendValidSuffixes(machine, sequence, suffixDepth, options.maxDepth, output);
    }
    if (options.includeNegative === true) {
      output.push(
        ...generateMachineSequences(machine, options).filter((sequence) =>
          sequence.steps.some((step) => step.negative === true),
        ),
      );
    }
  }
  return Object.freeze(uniqueSequences(output));
}

export function coverageForSequences(sequences: readonly ModelDrivenSequence[]): ModelCoverage {
  const states = new Set<string>();
  const transitions = new Set<string>();
  for (const sequence of sequences) {
    for (const state of sequence.coveredStates) states.add(state);
    for (const transition of sequence.coveredTransitions) transitions.add(transition);
  }
  return {
    states: [...states].sort(),
    transitions: [...transitions].sort(),
  };
}

function generateMachineSequences(
  machine: TransitionMachine,
  options: ModelDrivenGenerationOptions,
): readonly ModelDrivenSequence[] {
  const maxDepth = Math.max(1, Math.floor(options.maxDepth ?? machine.states.length + 1));
  const initial = initialState(machine);
  const operations = [...new Set(machine.transitions.map((transition) => transition.op))].sort();
  const queue: QueueItem[] = [
    { state: initial, steps: [], coveredStates: [initial], coveredTransitions: [] },
  ];
  const seen = new Set<string>();
  const positive: ModelDrivenSequence[] = [];
  const negative: ModelDrivenSequence[] = [];

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item.steps.length >= maxDepth) continue;
    const transitions = enabledTransitions(machine, item.state, item.steps.length === 0);
    const key = `${item.state}|${item.steps.map(stepKey).join('/')}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (options.includeNegative === true) {
      const enabled = new Set(transitions.map((transition) => transition.op));
      for (const operation of operations) {
        if (enabled.has(operation)) continue;
        negative.push({
          aggregate: machine.aggregate,
          steps: [
            ...item.steps,
            {
              operation,
              from: item.state,
              to: 'UNKNOWN',
              guardCel: null,
              input: {},
              negative: true,
              ...(latestTarget(item.steps) === undefined
                ? {}
                : { targetRef: latestTarget(item.steps) }),
            },
          ],
          finalState: item.state,
          coveredStates: item.coveredStates,
          coveredTransitions: item.coveredTransitions,
        });
      }
    }

    for (const transition of transitions) {
      if (transition.to === 'UNKNOWN') continue;
      const targetRef = isCreation(machine, transition)
        ? nextTarget(machine.aggregate, item.steps)
        : undefined;
      const step: ModelDrivenStep = {
        operation: transition.op,
        from: transition.from,
        to: transition.to,
        guardCel: transition.guardCel,
        input: {},
        ...(targetRef === undefined ? {} : { targetRef }),
        ...(targetRef === undefined && latestTarget(item.steps) === undefined
          ? {}
          : targetRef === undefined
            ? { targetRef: latestTarget(item.steps) }
            : {}),
      };
      const constrained = applyGuardConstraints(machine, [...item.steps, step]);
      const transitionKey = transitionKeyOf(transition);
      queue.push({
        state: transition.to,
        steps: constrained,
        coveredStates: [...new Set([...item.coveredStates, transition.to])],
        coveredTransitions: [...item.coveredTransitions, transitionKey],
      });
      positive.push({
        aggregate: machine.aggregate,
        steps: constrained,
        finalState: transition.to,
        coveredStates: [...new Set([...item.coveredStates, transition.to])],
        coveredTransitions: [...item.coveredTransitions, transitionKey],
      });
    }
  }

  const all = options.includeNegative === true ? [...positive, ...negative] : positive;
  return Object.freeze(uniqueSequences(all));
}

function extendValidSuffixes(
  machine: TransitionMachine,
  sequence: ModelDrivenSequence,
  depth: number,
  maxDepth: number | undefined,
  output: ModelDrivenSequence[],
): void {
  if (depth <= 0 || (maxDepth !== undefined && sequence.steps.length >= maxDepth)) return;
  const transitions = enabledTransitions(machine, sequence.finalState, false);
  for (const transition of transitions) {
    if (transition.to === 'UNKNOWN') continue;
    const targetRef = isCreation(machine, transition)
      ? nextTarget(machine.aggregate, sequence.steps)
      : undefined;
    const step: ModelDrivenStep = {
      operation: transition.op,
      from: transition.from,
      to: transition.to,
      guardCel: transition.guardCel,
      input: {},
      ...(targetRef === undefined
        ? latestTarget(sequence.steps) === undefined
          ? {}
          : { targetRef: latestTarget(sequence.steps) }
        : { targetRef }),
    };
    const steps = applyGuardConstraints(machine, [...sequence.steps, step]);
    output.push({
      aggregate: machine.aggregate,
      steps,
      finalState: transition.to,
      coveredStates: [...new Set([...sequence.coveredStates, transition.to])],
      coveredTransitions: [...sequence.coveredTransitions, transitionKeyOf(transition)],
    });
    extendValidSuffixes(
      machine,
      {
        ...sequence,
        steps,
        finalState: transition.to,
        coveredStates: [...new Set([...sequence.coveredStates, transition.to])],
        coveredTransitions: [...sequence.coveredTransitions, transitionKeyOf(transition)],
      },
      depth - 1,
      maxDepth,
      output,
    );
  }
}

function enabledTransitions(
  machine: TransitionMachine,
  state: string,
  atRoot: boolean,
): readonly Transition[] {
  const wildcard = machine.transitions.filter((transition) => transition.from === '*');
  if (atRoot) {
    const creations = wildcard.filter((transition) => isCreation(machine, transition));
    return creations.length > 0 ? creations : wildcard;
  }
  return machine.transitions.filter(
    (transition) =>
      transition.from === state ||
      (transition.from === '*' && transition.guardCel?.includes('state.') === true),
  );
}

function initialState(machine: TransitionMachine): string {
  return (
    machine.analysis?.initialStates?.[0] ??
    machine.transitions.find((transition) => transition.from === '*')?.to ??
    machine.states[0] ??
    'UNKNOWN'
  );
}

function applyGuardConstraints(
  machine: TransitionMachine,
  steps: readonly ModelDrivenStep[],
): readonly ModelDrivenStep[] {
  const latest = steps.at(-1);
  if (latest === undefined || latest.guardCel === null) return steps;
  const constraints = [
    ...latest.guardCel.matchAll(/(!\(\s*)?state\.([A-Za-z0-9_.-]+)\s*==\s*['"]([^'"]+)['"]/g),
  ]
    .filter((match) => match[1] === undefined)
    .map((match) => ({ field: match[2]!, value: match[3]! }));
  if (constraints.length === 0) return satisfyDataGuards(machine, steps, latest.guardCel);
  const updated = steps.map((step) => ({ ...step, input: { ...step.input } }));
  for (const constraint of constraints) {
    const index = updated
      .slice(0, -1)
      .map((step, position) => ({ step, position }))
      .reverse()
      .find(({ step }) => writesField(machine, step.operation, constraint.field));
    if (index === undefined) continue;
    updated[index.position] = {
      ...updated[index.position]!,
      input: { ...updated[index.position]!.input, [constraint.field]: constraint.value },
    };
  }
  return satisfyDataGuards(machine, updated, latest.guardCel);
}

/**
 * Add a model-known support mutation when a guarded transition requires data
 * that the current state machine does not produce as a control-field change.
 * The canonical model still supplies the operation/write-set; only the
 * operation's request factory chooses the wire payload for that field.
 */
function satisfyDataGuards(
  machine: TransitionMachine,
  steps: readonly ModelDrivenStep[],
  guardCel: string,
): readonly ModelDrivenStep[] {
  const fields = [...guardCel.matchAll(/state\.([A-Za-z0-9_.-]+)\.exists\s*\(/g)].map(
    (match) => match[1]!,
  );
  if (fields.length === 0) return steps;
  const additions: ModelDrivenStep[] = [];
  for (const field of fields) {
    const alreadySatisfied = steps.some(
      (step) =>
        step !== steps.at(-1) &&
        !isCreation(machine, {
          from: step.from,
          to: step.to,
          op: step.operation,
          guardCel: step.guardCel,
          nextStateKnown: true,
        }) &&
        machine.writeSets[step.operation]?.fields.includes(field) === true,
    );
    if (alreadySatisfied) continue;
    const supportOperation = Object.entries(machine.writeSets)
      .filter(([, writeSet]) => writeSet.fields.includes(field))
      .filter(([operation]) => !isCreationOperation(machine, operation))
      .map(([operation]) => operation)
      .find((operation) => operation !== steps.at(-1)?.operation);
    const input = supportInput(field);
    const targetRef = latestTarget(steps.slice(0, -1));
    if (supportOperation === undefined || input === undefined || targetRef === undefined) continue;
    additions.push({
      operation: supportOperation,
      from: steps.at(-1)?.from ?? '*',
      to: steps.at(-1)?.from ?? '*',
      guardCel: null,
      input,
      targetRef,
    });
  }
  return additions.length === 0 ? steps : [...steps.slice(0, -1), ...additions, steps.at(-1)!];
}

function isCreationOperation(machine: TransitionMachine, operation: string): boolean {
  return machine.transitions.some(
    (transition) => transition.op === operation && isCreation(machine, transition),
  );
}

function supportInput(field: string): JsonObject | undefined {
  switch (field) {
    case 'callIds':
      return { callId: 'generated-call-1' };
    default:
      return undefined;
  }
}

function writesField(machine: TransitionMachine, operation: string, field: string): boolean {
  const writeSet = machine.writeSets[operation];
  return writeSet?.replaceState === true || writeSet?.fields.includes(field) === true;
}

function isCreation(machine: TransitionMachine, transition: Transition): boolean {
  const writeSet = machine.writeSets[transition.op];
  if (transition.from !== '*' || writeSet === undefined) return false;
  // Some YAML reducers build a newly-created entity with patch operations
  // rather than replace_state. The canonical model still identifies those
  // operations by their id write; treating them as creations keeps symbolic
  // target allocation faithful to the runtime without adding a source-specific
  // branch to the generator.
  return writeSet.replaceState || writeSet.fields.includes('id');
}

function nextTarget(aggregate: string, steps: readonly ModelDrivenStep[]): string {
  const count = steps.filter((step) => step.from === '*').length;
  return `${aggregate.toLowerCase()}-${count + 1}`;
}

function latestTarget(steps: readonly ModelDrivenStep[]): string | undefined {
  return [...steps].reverse().find((step) => step.targetRef !== undefined)?.targetRef;
}

function transitionKeyOf(transition: Transition): string {
  return `${transition.from}:${transition.op}->${transition.to}`;
}

function stepKey(step: ModelDrivenStep): string {
  return `${step.operation}:${step.to}:${JSON.stringify(step.input)}:${step.negative === true}`;
}

function uniqueSequences(sequences: readonly ModelDrivenSequence[]): ModelDrivenSequence[] {
  const seen = new Set<string>();
  const result: ModelDrivenSequence[] = [];
  for (const sequence of sequences) {
    const key = `${sequence.aggregate}|${sequence.steps.map(stepKey).join('/')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(sequence);
  }
  return result;
}
