import type { Transition, TransitionMachine } from '../../src/model/transitionModel.js';

/** Input role used in a simulation result. */
export type RefinementSide = 'specification' | 'implementation';

export type RefinementErrorCode =
  | 'REFINEMENT_MODEL_INVALID'
  | 'REFINEMENT_UNKNOWN_TRANSITION'
  | 'REFINEMENT_NONDETERMINISTIC';

export interface RefinementErrorDetails {
  readonly side: RefinementSide;
  readonly aggregate: string;
  readonly transition?: Transition;
  readonly state?: string;
  readonly operation?: string;
  readonly transitions?: readonly Transition[];
}

/**
 * A typed rejection from the finite-state analysis boundary.
 *
 * UNKNOWN transitions and unproved nondeterminism are rejected rather than
 * being approximated. A false refinement verdict is more dangerous than an
 * unavailable optional analysis.
 */
export class RefinementAnalysisError extends Error {
  public readonly code: RefinementErrorCode;
  public readonly details: RefinementErrorDetails;

  public constructor(code: RefinementErrorCode, message: string, details: RefinementErrorDetails) {
    super(message);
    this.name = 'RefinementAnalysisError';
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type RefinementFailureReason =
  | 'INITIAL_STATE_UNRELATED'
  | 'NO_MATCHING_OPERATION'
  | 'TARGET_NOT_RELATED';

export interface RefinementFailure {
  readonly implementationState: string;
  readonly specificationState: string;
  readonly operation?: string;
  readonly implementationTarget?: string;
  readonly reason: RefinementFailureReason;
}

export interface TransitionStatePair {
  readonly implementationState: string;
  readonly specificationState: string;
}

export interface RefinementResult {
  /** True when the implementation simulates/refines the specification. */
  readonly refines: boolean;
  /** The greatest simulation relation after fixed-point pruning. */
  readonly relation: readonly TransitionStatePair[];
  /** Failing implementation transitions, including initial-state failures. */
  readonly failures: readonly RefinementFailure[];
}

interface NormalizedMachine {
  readonly states: readonly string[];
  readonly transitions: readonly NormalizedTransition[];
  readonly initialStates: readonly string[];
}

interface NormalizedTransition {
  readonly from: string;
  readonly to: string;
  readonly op: string;
  readonly guardCel: string | null;
}

interface RelationKey {
  readonly implementationState: string;
  readonly specificationState: string;
}

/**
 * Check one-directional finite-state simulation.
 *
 * `implementation` refines `specification` when every implementation
 * transition from a related state has a same-labelled specification
 * transition to another related pair. Specification-only behaviour is
 * allowed. This is simulation/failures refinement, not bisimulation.
 */
export function checkFiniteStateRefinement(
  specification: TransitionMachine,
  implementation: TransitionMachine,
): RefinementResult {
  const normalizedSpecification = normalizeMachine(specification, 'specification');
  const normalizedImplementation = normalizeMachine(implementation, 'implementation');

  let relation = allPairs(normalizedImplementation.states, normalizedSpecification.states);
  let changed = true;
  while (changed) {
    changed = false;
    const nextRelation = new Set(relation);
    for (const encodedPair of relation) {
      const pair = parsePairKey(encodedPair);
      if (
        transitionFailuresForPair(pair, normalizedSpecification, normalizedImplementation, relation)
          .length > 0
      ) {
        nextRelation.delete(encodedPair);
        changed = true;
      }
    }
    relation = nextRelation;
  }

  const failures: RefinementFailure[] = [];
  for (const encodedPair of reachableCandidatePairs(
    normalizedSpecification,
    normalizedImplementation,
  )) {
    if (relation.has(encodedPair)) continue;
    const pair = parsePairKey(encodedPair);
    failures.push(
      ...transitionFailuresForPair(
        pair,
        normalizedSpecification,
        normalizedImplementation,
        relation,
      ),
    );
  }

  for (const implementationState of normalizedImplementation.initialStates) {
    const relatedInitial = normalizedSpecification.initialStates.some((specificationState) =>
      relation.has(pairKey({ implementationState, specificationState })),
    );
    if (relatedInitial) continue;
    if (normalizedSpecification.initialStates.length === 0) {
      failures.push({
        implementationState,
        specificationState: '<none>',
        reason: 'INITIAL_STATE_UNRELATED',
      });
      continue;
    }
    if (
      !failures.some(
        (failure) =>
          failure.implementationState === implementationState &&
          failure.reason !== 'INITIAL_STATE_UNRELATED',
      )
    ) {
      failures.push({
        implementationState,
        specificationState: normalizedSpecification.initialStates[0]!,
        reason: 'INITIAL_STATE_UNRELATED',
      });
    }
  }

  return {
    refines: failures.length === 0,
    relation: [...relation]
      .map((encodedPair) => {
        const { implementationState, specificationState } = parsePairKey(encodedPair);
        return {
          implementationState,
          specificationState,
        };
      })
      .sort(comparePairs),
    failures: uniqueFailures(failures),
  };
}

function normalizeMachine(machine: TransitionMachine, side: RefinementSide): NormalizedMachine {
  const states = [...new Set(machine.states)];
  if (states.length === 0) {
    throw analysisError(
      'REFINEMENT_MODEL_INVALID',
      `${side} machine "${machine.aggregate}" has no states`,
      { side, aggregate: machine.aggregate },
    );
  }

  const stateSet = new Set(states);
  const transitions = machine.transitions.flatMap((transition) => {
    if (!transition.nextStateKnown || transition.to === 'UNKNOWN') {
      throw analysisError(
        'REFINEMENT_UNKNOWN_TRANSITION',
        `${side} machine "${machine.aggregate}" contains an UNKNOWN transition for ${transition.op}`,
        { side, aggregate: machine.aggregate, transition },
      );
    }
    if (transition.op.trim() === '') {
      throw analysisError(
        'REFINEMENT_MODEL_INVALID',
        `${side} machine "${machine.aggregate}" contains a transition with an empty operation`,
        { side, aggregate: machine.aggregate, transition },
      );
    }
    if (transition.to === 'UNKNOWN' || !stateSet.has(transition.to)) {
      throw analysisError(
        'REFINEMENT_MODEL_INVALID',
        `${side} machine "${machine.aggregate}" targets undeclared state "${transition.to}"`,
        { side, aggregate: machine.aggregate, transition },
      );
    }
    const sources = transition.from === '*' ? states : [transition.from];
    for (const source of sources) {
      if (!stateSet.has(source)) {
        throw analysisError(
          'REFINEMENT_MODEL_INVALID',
          `${side} machine "${machine.aggregate}" starts a transition in undeclared state "${source}"`,
          { side, aggregate: machine.aggregate, transition, state: source },
        );
      }
    }
    return sources.map((from) => ({
      from,
      to: transition.to,
      op: transition.op,
      guardCel: transition.guardCel,
    }));
  });

  const uniqueTransitions = deduplicateTransitions(transitions);
  assertDeterministic(machine, side, uniqueTransitions);
  const initialStates = resolveInitialStates(machine, side, states, uniqueTransitions);
  return { states, transitions: uniqueTransitions, initialStates };
}

function resolveInitialStates(
  machine: TransitionMachine,
  side: RefinementSide,
  states: readonly string[],
  transitions: readonly NormalizedTransition[],
): readonly string[] {
  const configured = machine.analysis?.initialStates ?? [];
  for (const state of configured) {
    if (!states.includes(state)) {
      throw analysisError(
        'REFINEMENT_MODEL_INVALID',
        `${side} machine "${machine.aggregate}" declares undeclared initial state "${state}"`,
        { side, aggregate: machine.aggregate, state },
      );
    }
  }
  if (configured.length > 0) return [...new Set(configured)];

  // MODEL1 did not require an initial-state policy. The first declared state
  // is the deterministic fallback for this optional analysis; callers that
  // need a semantic initial state should provide analysis.initialStates.
  const incoming = new Set(transitions.map((transition) => transition.to));
  const inferred = states.filter((state) => !incoming.has(state));
  return inferred.length > 0 ? [inferred[0]!] : [states[0]!];
}

function assertDeterministic(
  machine: TransitionMachine,
  side: RefinementSide,
  transitions: readonly NormalizedTransition[],
): void {
  const grouped = new Map<string, NormalizedTransition[]>();
  for (const transition of transitions) {
    const key = `${transition.from}\u0000${transition.op}`;
    grouped.set(key, [...(grouped.get(key) ?? []), transition]);
  }
  for (const candidates of grouped.values()) {
    if (candidates.length < 2) continue;
    const pairwiseDisjoint = candidates.every((left, leftIndex) =>
      candidates
        .slice(leftIndex + 1)
        .every((right) => guardsAreDisjoint(left.guardCel, right.guardCel)),
    );
    if (pairwiseDisjoint) continue;
    throw analysisError(
      'REFINEMENT_NONDETERMINISTIC',
      `${side} machine "${machine.aggregate}" has unproved nondeterminism for ${candidates[0]!.from}/${candidates[0]!.op}`,
      {
        side,
        aggregate: machine.aggregate,
        state: candidates[0]!.from,
        operation: candidates[0]!.op,
        transitions: candidates.map(toTransition),
      },
    );
  }
}

function transitionFailuresForPair(
  pair: RelationKey,
  specification: NormalizedMachine,
  implementation: NormalizedMachine,
  relation: ReadonlySet<string>,
): readonly RefinementFailure[] {
  const failures: RefinementFailure[] = [];
  for (const transition of outgoing(implementation.transitions, pair.implementationState)) {
    const matches = outgoing(specification.transitions, pair.specificationState).filter(
      (candidate) => candidate.op === transition.op,
    );
    if (matches.length === 0) {
      failures.push({
        implementationState: pair.implementationState,
        specificationState: pair.specificationState,
        operation: transition.op,
        implementationTarget: transition.to,
        reason: 'NO_MATCHING_OPERATION',
      });
      continue;
    }
    if (
      !matches.some((candidate) =>
        relation.has(
          pairKey({
            implementationState: transition.to,
            specificationState: candidate.to,
          }),
        ),
      )
    ) {
      failures.push({
        implementationState: pair.implementationState,
        specificationState: pair.specificationState,
        operation: transition.op,
        implementationTarget: transition.to,
        reason: 'TARGET_NOT_RELATED',
      });
    }
  }
  return failures;
}

function outgoing(
  transitions: readonly NormalizedTransition[],
  state: string,
): readonly NormalizedTransition[] {
  return transitions.filter((transition) => transition.from === state);
}

function reachableCandidatePairs(
  specification: NormalizedMachine,
  implementation: NormalizedMachine,
): ReadonlySet<string> {
  const reachable = allPairs(implementation.initialStates, specification.initialStates);
  const pending = [...reachable];
  while (pending.length > 0) {
    const pair = parsePairKey(pending.shift()!);
    for (const implementationTransition of outgoing(
      implementation.transitions,
      pair.implementationState,
    )) {
      for (const specificationTransition of outgoing(
        specification.transitions,
        pair.specificationState,
      ).filter((candidate) => candidate.op === implementationTransition.op)) {
        const nextPair = pairKey({
          implementationState: implementationTransition.to,
          specificationState: specificationTransition.to,
        });
        if (reachable.has(nextPair)) continue;
        reachable.add(nextPair);
        pending.push(nextPair);
      }
    }
  }
  return reachable;
}

function allPairs(
  implementationStates: readonly string[],
  specificationStates: readonly string[],
): Set<string> {
  const result = new Set<string>();
  for (const implementationState of implementationStates) {
    for (const specificationState of specificationStates) {
      result.add(pairKey({ implementationState, specificationState }));
    }
  }
  return result;
}

function pairKey(pair: RelationKey): string {
  return `${JSON.stringify(pair.implementationState)}\u0000${JSON.stringify(pair.specificationState)}`;
}

function parsePairKey(value: string): RelationKey {
  const separator = value.indexOf('\u0000');
  return {
    implementationState: JSON.parse(value.slice(0, separator)) as string,
    specificationState: JSON.parse(value.slice(separator + 1)) as string,
  };
}

function deduplicateTransitions(
  transitions: readonly NormalizedTransition[],
): readonly NormalizedTransition[] {
  const seen = new Set<string>();
  return transitions.filter((transition) => {
    const key = JSON.stringify(transition);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toTransition(transition: NormalizedTransition): Transition {
  return {
    from: transition.from,
    to: transition.to,
    op: transition.op,
    guardCel: transition.guardCel,
    nextStateKnown: true,
  };
}

interface GuardAtom {
  readonly field: string;
  readonly value: string;
  readonly negated: boolean;
}

/**
 * Prove only the small, obvious disjointness fragment. Arbitrary CEL is not
 * solved here; such branches are rejected as unproved nondeterminism.
 */
function guardsAreDisjoint(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return false;
  const leftAtoms = parseConjunctiveGuard(left);
  const rightAtoms = parseConjunctiveGuard(right);
  if (leftAtoms === undefined || rightAtoms === undefined) return false;
  return leftAtoms.some((leftAtom) =>
    rightAtoms.some(
      (rightAtom) =>
        leftAtom.field === rightAtom.field &&
        ((leftAtom.value === rightAtom.value && leftAtom.negated !== rightAtom.negated) ||
          (!leftAtom.negated && !rightAtom.negated && leftAtom.value !== rightAtom.value)),
    ),
  );
}

function parseConjunctiveGuard(expression: string): readonly GuardAtom[] | undefined {
  const atoms: GuardAtom[] = [];
  for (const rawPart of expression.split(/\s*&&\s*/)) {
    let part = stripOuterParentheses(rawPart.trim());
    let negated = false;
    if (part.startsWith('!')) {
      negated = true;
      part = stripOuterParentheses(part.slice(1).trim());
    }
    const match = part.match(/^state\.([A-Za-z_][A-Za-z0-9_.-]*)\s*(==|!=)\s*(['"])(.*?)\3$/);
    if (match === null) return undefined;
    const operatorNegated = match[2] === '!=';
    atoms.push({ field: match[1]!, value: match[4]!, negated: negated !== operatorNegated });
  }
  return atoms.length === 0 ? undefined : atoms;
}

function stripOuterParentheses(value: string): string {
  let result = value;
  while (result.startsWith('(') && result.endsWith(')') && balancedOuterPair(result)) {
    result = result.slice(1, -1).trim();
  }
  return result;
}

function balancedOuterPair(value: string): boolean {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (depth === 0 && index < value.length - 1) return false;
  }
  return depth === 0;
}

function uniqueFailures(failures: readonly RefinementFailure[]): readonly RefinementFailure[] {
  const seen = new Set<string>();
  return failures.filter((failure) => {
    const key = JSON.stringify(failure);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function comparePairs(left: TransitionStatePair, right: TransitionStatePair): number {
  return (
    left.implementationState.localeCompare(right.implementationState) ||
    left.specificationState.localeCompare(right.specificationState)
  );
}

function analysisError(
  code: RefinementErrorCode,
  message: string,
  details: RefinementErrorDetails,
): RefinementAnalysisError {
  return new RefinementAnalysisError(code, message, details);
}
