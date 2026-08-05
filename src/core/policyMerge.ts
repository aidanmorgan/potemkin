import type { RuntimeModelCoverage, RuntimePolicies } from '../model/runtime.js';

/** Merge source-independent policy fragments without source-specific branches. */
export function mergeRuntimePolicies(policies: readonly RuntimePolicies[]): RuntimePolicies {
  return {
    ...policies.reduce<Record<string, unknown>>((merged, policy) => ({ ...merged, ...policy }), {}),
    faults: policies.flatMap((policy) => policy.faults ?? []),
    reactions: policies.flatMap((policy) => policy.reactions ?? []),
    sagas: policies.flatMap((policy) => policy.sagas ?? []),
    derivedProjections: policies.flatMap((policy) => policy.derivedProjections ?? []),
    webhooks: policies.flatMap((policy) => policy.webhooks ?? []),
    ...(mergeCoverage(policies) === undefined ? {} : { coverage: mergeCoverage(policies) }),
  } as RuntimePolicies;
}

function mergeCoverage(policies: readonly RuntimePolicies[]): RuntimePolicies['coverage'] {
  const entries = policies.flatMap((policy) => Object.entries(policy.coverage ?? {}));
  if (entries.length === 0) return undefined;
  const merged = new Map<string, RuntimeModelCoverage>();
  for (const [aggregate, policy] of entries) {
    const previous = merged.get(aggregate);
    if (previous === undefined) {
      merged.set(aggregate, policy);
      continue;
    }
    merged.set(aggregate, {
      ...(previous.strict === true || policy.strict === true ? { strict: true } : {}),
      ...mergeValues('initialStates', previous.initialStates, policy.initialStates),
      ...mergeValues('terminalStates', previous.terminalStates, policy.terminalStates),
      ...mergeValues('operations', previous.operations, policy.operations),
      ...mergeValues('suppressStates', previous.suppressStates, policy.suppressStates),
    });
  }
  return Object.fromEntries(merged);
}

function mergeValues(
  key: 'initialStates' | 'terminalStates' | 'operations' | 'suppressStates',
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): Partial<RuntimeModelCoverage> {
  const values = [...new Set([...(left ?? []), ...(right ?? [])])].sort();
  return values.length === 0 ? {} : { [key]: values };
}
