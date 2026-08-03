import type {
  Transition,
  TransitionMachine,
  TransitionModel,
} from "../../src/model/transitionModel.js";
import { checkMetamorphicRelation } from "./metamorphic.js";
import type {
  EquivalenceDivergence,
  EquivalenceRequest,
  EquivalenceResponse,
  MetamorphicRelation,
} from "./types.js";

export type ModelMetamorphicRelationKind = "idempotency" | "commutativity";

export interface ModelMetamorphicRelation {
  readonly name: string;
  readonly kind: ModelMetamorphicRelationKind;
  readonly aggregates: readonly string[];
  readonly operations: readonly string[];
  readonly requests: readonly EquivalenceRequest[];
  readonly replay: readonly EquivalenceRequest[];
  readonly relation: MetamorphicRelation;
}

export interface ModelMetamorphicRequestFactory {
  requestFor(
    machine: TransitionMachine,
    operation: string,
    transition: Transition | undefined,
  ): EquivalenceRequest | undefined;
}

export interface ModelMetamorphicTarget {
  reset(): Promise<void>;
  execute(requests: readonly EquivalenceRequest[]): Promise<readonly EquivalenceResponse[]>;
}

export interface ModelMetamorphicResult {
  readonly relation: ModelMetamorphicRelation;
  readonly divergences: readonly EquivalenceDivergence[];
}

/**
 * Derive only relations which the canonical MODEL1 write-set algebra can prove.
 * The factory supplies wire requests; it does not decide which operations are
 * safe to relate. That decision stays entirely in this source-independent test
 * module.
 */
export function deriveModelMetamorphicRelations(
  model: TransitionModel,
  requests: ModelMetamorphicRequestFactory,
): readonly ModelMetamorphicRelation[] {
  const relations: ModelMetamorphicRelation[] = [];
  for (const machine of model.machines) {
    for (const operation of idempotentOperations(machine)) {
      const request = requests.requestFor(machine, operation, firstTransition(machine, operation));
      if (request === undefined) continue;
      relations.push({
        name: `idempotent:${machine.aggregate}:${operation}`,
        kind: "idempotency",
        aggregates: [machine.aggregate],
        operations: [operation],
        requests: [request],
        replay: [request, request],
        relation: idempotentRelation(`idempotent:${machine.aggregate}:${operation}`, request),
      });
    }
  }

  const operations = model.machines.flatMap((machine) =>
    candidateOperations(machine).map((operation) => ({ machine, operation })),
  );
  for (let leftIndex = 0; leftIndex < operations.length; leftIndex += 1) {
    const left = operations[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < operations.length; rightIndex += 1) {
      const right = operations[rightIndex]!;
      if (!provablyDisjoint(left.machine, left.operation, right.machine, right.operation)) continue;
      const leftRequest = requests.requestFor(
        left.machine,
        left.operation,
        firstTransition(left.machine, left.operation),
      );
      const rightRequest = requests.requestFor(
        right.machine,
        right.operation,
        firstTransition(right.machine, right.operation),
      );
      if (leftRequest === undefined || rightRequest === undefined) continue;
      const name = `commutes:${left.machine.aggregate}:${left.operation}|${right.machine.aggregate}:${right.operation}`;
      relations.push({
        name,
        kind: "commutativity",
        aggregates: [left.machine.aggregate, right.machine.aggregate],
        operations: [left.operation, right.operation],
        requests: [leftRequest, rightRequest],
        replay: [rightRequest, leftRequest],
        relation: commutingRelation(name, leftRequest, rightRequest),
      });
    }
  }
  return Object.freeze(relations);
}

/** Run a derived relation against any configured EQ2-compatible target. */
export async function runModelMetamorphicRelation(
  relation: ModelMetamorphicRelation,
  target: ModelMetamorphicTarget,
  baseSequence: readonly EquivalenceRequest[] = [],
): Promise<ModelMetamorphicResult> {
  await target.reset();
  const before = await target.execute([...baseSequence, ...relation.requests]);
  await target.reset();
  const after = await target.execute([...baseSequence, ...relation.replay]);
  return {
    relation,
    divergences: checkMetamorphicRelation(relation.relation, baseSequence, before, after),
  };
}

function idempotentOperations(machine: TransitionMachine): readonly string[] {
  const transitionsByOperation = new Map<string, Transition[]>();
  for (const transition of machine.transitions) {
    const transitions = transitionsByOperation.get(transition.op) ?? [];
    transitions.push(transition);
    transitionsByOperation.set(transition.op, transitions);
  }
  return [...transitionsByOperation.entries()]
    .filter(([operation, transitions]) => {
      const writeSet = machine.writeSets[operation];
      if (writeSet === undefined || writeSet.volatile.length > 0) return false;
      const knownStates = transitions.every((transition) => transition.nextStateKnown);
      const targets = new Set(transitions.map((transition) => transition.to));
      return knownStates && targets.size === 1 && writeSet.replaceState === false;
    })
    .map(([operation]) => operation)
    .sort();
}

function candidateOperations(machine: TransitionMachine): readonly string[] {
  return Object.keys(machine.writeSets)
    .filter((operation) => machine.writeSets[operation] !== undefined)
    .sort();
}

function firstTransition(machine: TransitionMachine, operation: string): Transition | undefined {
  return machine.transitions.find((transition) => transition.op === operation);
}

function provablyDisjoint(
  leftMachine: TransitionMachine,
  leftOperation: string,
  rightMachine: TransitionMachine,
  rightOperation: string,
): boolean {
  if (leftMachine.aggregate === rightMachine.aggregate && leftOperation === rightOperation)
    return false;
  const left = namespacedWriteFields(leftMachine, leftOperation);
  const right = namespacedWriteFields(rightMachine, rightOperation);
  return [...left].every((field) => !right.has(field));
}

function namespacedWriteFields(machine: TransitionMachine, operation: string): ReadonlySet<string> {
  const writeSet = machine.writeSets[operation];
  if (writeSet === undefined) return new Set();
  return new Set(
    [...writeSet.fields, ...writeSet.derivedClosure].map(
      (field) => `${machine.aggregate}:${field}`,
    ),
  );
}

function idempotentRelation(name: string, request: EquivalenceRequest): MetamorphicRelation {
  return {
    name,
    apply: (sequence) => [...sequence, request],
    assert: (before, after) => compareResponseAt(name, before.at(-1), after.at(-1)),
  };
}

function commutingRelation(
  name: string,
  left: EquivalenceRequest,
  right: EquivalenceRequest,
): MetamorphicRelation {
  return {
    name,
    apply: (sequence) => [...sequence, right, left],
    assert: (before, after) => [
      ...compareResponseAt(name, before.at(-2), after.at(-1)),
      ...compareResponseAt(name, before.at(-1), after.at(-2)),
    ],
  };
}

function compareResponseAt(
  operation: string,
  expected: EquivalenceResponse | undefined,
  actual: EquivalenceResponse | undefined,
): readonly EquivalenceDivergence[] {
  if (expected === undefined || actual === undefined)
    return [
      {
        code: "BODY_MISMATCH",
        operation,
        path: "$",
        message: "Metamorphic relation produced a different number of observations",
      },
    ];
  if (
    expected.status === actual.status &&
    JSON.stringify(expected.body) === JSON.stringify(actual.body)
  )
    return [];
  return [
    {
      code: "BODY_MISMATCH",
      operation,
      path: "$",
      expected: expected.body ?? null,
      actual: actual.body ?? null,
      message: "Model-derived metamorphic relation changed the observable response",
    },
  ];
}
