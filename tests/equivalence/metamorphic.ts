import type {
  EquivalenceDivergence,
  EquivalenceRequest,
  EquivalenceResponse,
  MetamorphicRelation,
} from './types.js';

/** A relation whose output must not change when the same request is repeated. */
export function idempotentRelation(name: string, request: EquivalenceRequest): MetamorphicRelation {
  return {
    name,
    apply: (sequence) => [...sequence, request],
    assert: (before, after) => compareResponses(name, before.at(-1), after.at(-1)),
  };
}

/** Check that independent requests commute when a model declares them disjoint. */
export function commutingRelation(
  name: string,
  left: EquivalenceRequest,
  right: EquivalenceRequest,
): MetamorphicRelation {
  return {
    name,
    apply: (sequence) => [...sequence, right, left],
    assert: (before, after) => {
      const divergences = compareResponses(name, before.at(-1), after.at(-1));
      if (divergences.length > 0) return divergences;
      return compareResponses(name, before.at(-2), after.at(-2));
    },
  };
}

/** Apply a relation to a trace and return its semantic response violations. */
export function checkMetamorphicRelation(
  relation: MetamorphicRelation,
  sequence: readonly EquivalenceRequest[],
  before: readonly EquivalenceResponse[],
  after: readonly EquivalenceResponse[],
): readonly EquivalenceDivergence[] {
  void relation.apply(sequence);
  return relation.assert(before, after);
}

function compareResponses(
  operation: string,
  expected: EquivalenceResponse | undefined,
  actual: EquivalenceResponse | undefined,
): readonly EquivalenceDivergence[] {
  if (expected === undefined || actual === undefined) {
    return [
      {
        code: 'BODY_MISMATCH',
        operation,
        path: '$',
        message: 'Metamorphic relation produced a different number of observations',
      },
    ];
  }
  if (
    expected.status !== actual.status ||
    JSON.stringify(expected.body) !== JSON.stringify(actual.body)
  ) {
    return [
      {
        code: 'BODY_MISMATCH',
        operation,
        path: '$',
        expected: expected.body ?? null,
        actual: actual.body ?? null,
        message: 'Metamorphic relation changed the observable response',
      },
    ];
  }
  return [];
}
