import type { TransitionMachine } from "../../src/model/transitionModel.js";
import type { DualRunResult, SymbolicSequenceStep } from "./dualRunner.js";

export type IdentifierDomain = "equality-freshness" | "arbitrary";

export type ActiveLearningErrorCode =
  | "LEARNING_PRECONDITION_UNSATISFIED"
  | "LEARNING_CONFIGURATION_INVALID"
  | "LEARNING_INCONCLUSIVE";

export class ActiveLearningError extends Error {
  public readonly code: ActiveLearningErrorCode;

  public constructor(code: ActiveLearningErrorCode, message: string) {
    super(message);
    this.name = "ActiveLearningError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The smallest EQ2 surface needed by the discovery harness. */
export interface ActiveLearningRunner {
  run(
    sequence: readonly SymbolicSequenceStep[],
  ): Promise<Pick<DualRunResult, "steps" | "inconclusive">>;
}

export interface ActiveLearningOptions {
  readonly identifierDomain: IdentifierDomain;
  readonly maxDepth?: number;
}

export interface LearnedState {
  readonly id: string;
  readonly signature: string;
}

export interface LearnedTransition {
  readonly from: string;
  readonly operation: string;
  readonly to: string;
}

export interface LearnedHypothesis {
  readonly initialState: string;
  readonly states: readonly LearnedState[];
  readonly transitions: readonly LearnedTransition[];
  readonly queriedSequences: number;
}

export type LearnedModelDifferenceKind =
  | "UNMODELED_OPERATION"
  | "UNOBSERVED_OPERATION"
  | "UNMODELED_TRANSITION";

export interface LearnedModelDifference {
  readonly kind: LearnedModelDifferenceKind;
  readonly operation: string;
  readonly from?: string;
  readonly to?: string;
}

/**
 * Run a bounded prefix learner against the EQ2 runner.
 *
 * This is discovery evidence only. It builds a deterministic observation-tree
 * hypothesis from membership queries and deliberately does not claim a full
 * register-automata learning result. The equality/freshness identifier
 * precondition is explicit because arbitrary identifier domains are outside
 * the sound fragment being explored here.
 */
export async function learnBoundedHypothesis(
  runner: ActiveLearningRunner,
  alphabet: readonly SymbolicSequenceStep[],
  options: ActiveLearningOptions,
): Promise<LearnedHypothesis> {
  validateOptions(options, alphabet);
  const maxDepth = Math.max(1, Math.floor(options.maxDepth ?? alphabet.length + 1));
  const prefixes = boundedPrefixes(alphabet, maxDepth);
  const states: LearnedState[] = [{ id: "s0", signature: "<initial>" }];
  const stateBySignature = new Map<string, string>([["<initial>", "s0"]]);
  const transitions = new Map<string, LearnedTransition>();

  for (const prefix of prefixes) {
    const result = await runner.run(prefix);
    if (result.inconclusive) {
      throw new ActiveLearningError(
        "LEARNING_INCONCLUSIVE",
        `The EQ2 teacher was inconclusive for a ${prefix.length}-step membership query`,
      );
    }
    let from = "s0";
    for (const step of result.steps) {
      const signature = observationSignature(step.real.status, step.real.body ?? null);
      const to =
        stateBySignature.get(signature) ?? createState(signature, states, stateBySignature);
      transitions.set(`${from}\u0000${step.operation}\u0000${to}`, {
        from,
        operation: step.operation,
        to,
      });
      from = to;
    }
  }

  return {
    initialState: "s0",
    states: Object.freeze([...states]),
    transitions: Object.freeze([...transitions.values()]),
    queriedSequences: prefixes.length,
  };
}

/** Compare the discovered operation/transition surface with MODEL1. */
export function diffLearnedHypothesis(
  hypothesis: LearnedHypothesis,
  model: TransitionMachine,
): readonly LearnedModelDifference[] {
  const modelOperations = new Set(model.transitions.map((transition) => transition.op));
  const learnedOperations = new Set(
    hypothesis.transitions.map((transition) => transition.operation),
  );
  const differences: LearnedModelDifference[] = [];

  for (const operation of learnedOperations) {
    if (!modelOperations.has(operation)) {
      differences.push({ kind: "UNMODELED_OPERATION", operation });
    }
  }
  for (const operation of modelOperations) {
    if (!learnedOperations.has(operation)) {
      differences.push({ kind: "UNOBSERVED_OPERATION", operation });
    }
  }

  const modelTransitionKeys = new Set(
    model.transitions.map((transition) => `${transition.op}\u0000${transition.to}`),
  );
  for (const transition of hypothesis.transitions) {
    if (!modelTransitionKeys.has(`${transition.operation}\u0000${transition.to}`)) {
      differences.push({
        kind: "UNMODELED_TRANSITION",
        operation: transition.operation,
        from: transition.from,
        to: transition.to,
      });
    }
  }
  return Object.freeze(differences);
}

function validateOptions(
  options: ActiveLearningOptions,
  alphabet: readonly SymbolicSequenceStep[],
): void {
  if (options.identifierDomain !== "equality-freshness") {
    throw new ActiveLearningError(
      "LEARNING_PRECONDITION_UNSATISFIED",
      "Active learning requires an equality/freshness-only identifier domain",
    );
  }
  if (alphabet.length === 0) {
    throw new ActiveLearningError(
      "LEARNING_CONFIGURATION_INVALID",
      "Active learning requires a non-empty operation alphabet",
    );
  }
  if (
    options.maxDepth !== undefined &&
    (!Number.isFinite(options.maxDepth) || options.maxDepth < 1)
  ) {
    throw new ActiveLearningError(
      "LEARNING_CONFIGURATION_INVALID",
      "Active learning maxDepth must be a finite positive number",
    );
  }
}

function boundedPrefixes(
  alphabet: readonly SymbolicSequenceStep[],
  maxDepth: number,
): readonly (readonly SymbolicSequenceStep[])[] {
  const result: (readonly SymbolicSequenceStep[])[] = [[]];
  let frontier: readonly (readonly SymbolicSequenceStep[])[] = [[]];
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const next: (readonly SymbolicSequenceStep[])[] = [];
    for (const prefix of frontier) {
      for (const operation of alphabet) {
        const candidate = [...prefix, operation];
        result.push(candidate);
        next.push(candidate);
      }
    }
    frontier = next;
  }
  return result.slice(1);
}

function createState(
  signature: string,
  states: LearnedState[],
  stateBySignature: Map<string, string>,
): string {
  const id = `s${states.length}`;
  states.push({ id, signature });
  stateBySignature.set(signature, id);
  return id;
}

function observationSignature(status: number, body: unknown): string {
  return JSON.stringify({ status, body: normalizeFreshIdentifiers(body) });
}

function normalizeFreshIdentifiers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeFreshIdentifiers);
  if (value === null || typeof value !== "object") {
    if (typeof value !== "string") return value;
    return value.replace(/\b(pi|ch|cus|prod|price|re|ord|acct)_[A-Za-z0-9_-]+\b/g, "$1_<fresh>");
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      normalizeFreshIdentifiers(child),
    ]),
  );
}
